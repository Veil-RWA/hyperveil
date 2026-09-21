// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OAppLite} from "./lz/OAppLite.sol";
import {Origin} from "./lz/ILayerZeroEndpointV2.sol";
import {HyperVeilCodec as Codec} from "./HyperVeilCodec.sol";
import {HyperCore} from "./hyperliquid/HyperCore.sol";
import {IERC20, ITokenMessengerV2, IMessageTransmitterV2, ICoreDepositWallet} from "./cctp/ICctp.sol";

/// HyperVeil's omnibus: one HyperEVM contract whose HyperCore account holds
/// every asset behind HyperVeil's Starknet twins and trades them on HyperCore's
/// spot books on the Starknet gateway's instructions.
///
/// It keeps one ledger, `liability[token]`: how many twins of each HyperCore
/// token exist (or are about to) on Starknet. Every increase — a deposit
/// credited, a fill delivered, a refund on close — is checked against the
/// account's real HyperCore balance (spotBalance precompile) before the
/// message that mints them is sent. Every decrease is a twin burned on
/// Starknet first (an order's escrow when it is routed, a USDC exit). So twins
/// never outnumber what this account holds.
///
/// Instructions (Starknet -> here, over LayerZero):
///   DEPOSIT   a deposit's instruction. Credited only once the matching CCTP
///             USDC has arrived too (`receiveDeposit`) and reached HyperCore
///             (`creditDeposit`, a later block).
///   PLACE     a Veil order's escrow, to be placed as a spot limit order. The
///             order is checked against the Veil order's own terms first: the
///             pair, the escrow and the maker's limit price at the worst fee
///             (`maxFeeBps`) must all hold for every possible fill, or it is
///             rejected and the whole escrow goes back.
///   CANCEL    cancel the route's HyperCore order.
///   WITHDRAW  a USDC exit: HyperCore -> HyperEVM, then CCTP to Starknet's exit
///             vault (`burnExit`, once the USDC reached the EVM).
///
/// Results (here -> Starknet): CREDIT for a deposit, FILL for executions.
/// HyperEVM can read balances but not order results (there is no fill or
/// order-status precompile), so the keeper reports executions (`report`). The
/// keeper is bounded, not trusted: a report cannot draw more than the escrow,
/// cannot beat the maker's limit price, and cannot leave any token insolvent.
/// It can delay; it can misattribute between concurrent routes of one token
/// (the balance check is per token, not per route); it cannot mint a twin this
/// account does not hold.
///
/// Fees: the Starknet user pays. Each instruction arrives with HYPE (LayerZero
/// executor value) that is kept as that id's `budget` and pays its replies and
/// the keeper's per-step fee.
contract HyperVeilOmnibus is OAppLite {
    uint32 public constant STARKNET_DOMAIN = 25;
    uint64 public constant USDC_TOKEN = 0;
    uint256 public constant USDC_CORE_PER_CCTP_UNIT = 100;
    address public constant USDC_SYSTEM_ADDRESS = 0x2000000000000000000000000000000000000000;
    uint16 public constant MAX_FEE_BPS_CEILING = 100;

    // CCTP V2 message layout (identical on every chain).
    uint256 private constant CCTP_SOURCE_DOMAIN = 4;
    uint256 private constant CCTP_DESTINATION_CALLER = 108;
    uint256 private constant CCTP_BODY = 148;
    uint256 private constant CCTP_MINT_RECIPIENT = CCTP_BODY + 36;
    uint256 private constant CCTP_MESSAGE_SENDER = CCTP_BODY + 100;
    uint256 private constant CCTP_HOOK_DATA = CCTP_BODY + 228;

    uint8 public constant ROUTE_NONE = 0;
    uint8 public constant ROUTE_OPEN = 1;
    uint8 public constant ROUTE_CLOSED = 2;
    uint8 public constant ROUTE_REJECTED = 3;

    uint8 public constant EXIT_NONE = 0;
    uint8 public constant EXIT_REQUESTED = 1;
    uint8 public constant EXIT_BURNED = 2;

    uint32 public immutable starknetEid;
    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;
    IMessageTransmitterV2 public immutable messageTransmitter;
    ICoreDepositWallet public immutable coreDepositWallet;

    address public keeper;
    /// The Starknet entry helper: the only CCTP sender a deposit is accepted from.
    bytes32 public entryHelper;
    /// The Starknet exit vault: mint recipient and sole relayer of exits.
    bytes32 public exitVault;
    /// Worst spot fee assumed when bounding an order (bps). Hyperliquid's base
    /// spot taker fee is 7 bps; tiers and discounts only lower it.
    uint16 public maxFeeBps = 10;
    uint256 public exitCctpMaxFee;
    uint32 public exitMinFinality = 2000;
    /// Starknet `lz_receive` gas for the replies, in Starknet L2 gas (Sierra
    /// gas), not EVM gas. Measured against the real Veil pool (snforge,
    /// 2026-09-19): a CREDIT ~11M, a FILL ~4M plus ~12M per item; these leave
    /// about 3x headroom. Owner-settable (`setGas`).
    uint128 public creditGas = 40_000_000;
    uint128 public fillGas = 20_000_000;
    uint128 public fillGasPerItem = 30_000_000;
    /// HYPE paid to whoever performs a step (credit, report, burn), from the
    /// step's budget.
    uint256 public keeperFee;

    /// Twins of each HyperCore token outstanding on Starknet, in HyperCore wei.
    mapping(uint64 => uint256) public liability;

    struct Deposit {
        uint128 lzAmount6;
        uint128 arrived6;
        uint64 arrivedBlock;
        bool lzSeen;
        bool cctpSeen;
        bool credited;
    }

    struct Route {
        uint8 status;
        uint128 cloid;
        uint32 asset;
        bool isBuy;
        uint64 offerToken;
        uint64 wantToken;
        uint128 offerAmount;
        uint128 wantAmount;
        uint128 escrow;
        uint128 cumDraw;
        uint128 cumDeliver;
        uint64 seq;
    }

    struct Exit {
        uint128 amount8;
        uint8 status;
    }

    /// One keeper report: a route's cumulative execution so far, and whether
    /// its HyperCore order is over (filled, cancelled, expired or rejected).
    struct Report {
        bytes32 routeId;
        uint128 cumDraw;
        uint128 cumDeliver;
        bool closed;
    }

    mapping(bytes32 => Deposit) public deposits;
    mapping(bytes32 => Route) public routes;
    /// A CANCEL that overtook its PLACE (LayerZero is unordered here).
    mapping(bytes32 => bool) public cancelledEarly;
    mapping(bytes32 => Exit) public exits;
    /// HYPE delivered with each instruction, to pay what answers it.
    mapping(bytes32 => uint256) public budget;

    event DepositNoted(bytes32 indexed depositId, uint128 amountUsdc6);
    event DepositArrived(bytes32 indexed depositId, uint256 amountUsdc6);
    event DepositCredited(bytes32 indexed depositId, uint128 amount);
    event Placed(bytes32 indexed routeId, uint32 asset, bool isBuy, uint64 px, uint64 sz, uint8 tif);
    event PlaceRejected(bytes32 indexed routeId, bytes32 reason);
    event CancelSent(bytes32 indexed routeId);
    event Reported(bytes32 indexed routeId, uint64 seq, uint128 cumDraw, uint128 cumDeliver, bool closed);
    event ExitRequested(bytes32 indexed exitId, uint128 amount);
    event ExitBurned(bytes32 indexed exitId, uint256 amountUsdc6);
    event BudgetFunded(bytes32 indexed id, uint256 amount);
    event ConfigSet(bytes32 indexed what, uint256 value);

    error UnknownKind(uint8 kind);
    error OnlyKeeper();
    error DuplicateInstruction(bytes32 id);
    error RouteNotOpen(bytes32 routeId);
    error Regressed(bytes32 routeId);
    error OverEscrow(bytes32 routeId);
    error DrawWithoutDelivery(bytes32 routeId);
    error EmptyReport(bytes32 routeId);
    error LimitPrice(bytes32 routeId);
    error Insolvent(uint64 token, uint256 held, uint256 owed);
    error LiabilityUnderflow(uint64 token);
    error BadCctpMessage(bytes32 what);
    error DepositNotReady(bytes32 depositId);
    error ExitNotReady(bytes32 exitId);
    error BudgetTooLow(uint256 fee, uint256 available);
    error BadConfig();

    constructor(
        address endpoint_,
        address owner_,
        uint32 starknetEid_,
        address usdc_,
        address tokenMessenger_,
        address messageTransmitter_,
        address coreDepositWallet_
    ) OAppLite(endpoint_, owner_) {
        if (
            usdc_ == address(0) || tokenMessenger_ == address(0) || messageTransmitter_ == address(0)
                || coreDepositWallet_ == address(0)
        ) revert ZeroAddress();
        starknetEid = starknetEid_;
        usdc = IERC20(usdc_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        messageTransmitter = IMessageTransmitterV2(messageTransmitter_);
        coreDepositWallet = ICoreDepositWallet(coreDepositWallet_);
    }

    /// Endpoint refunds land here; nothing is owed to anyone for them.
    receive() external payable {}

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert OnlyKeeper();
        _;
    }

    // ------------------------------------------------------------------ inbound

    function _lzReceive(Origin calldata, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        bytes memory m = message;
        uint8 k = Codec.kind(m);
        if (k == Codec.KIND_DEPOSIT) {
            _onDeposit(m);
        } else if (k == Codec.KIND_PLACE) {
            _onPlace(m);
        } else if (k == Codec.KIND_CANCEL) {
            _onCancel(m);
        } else if (k == Codec.KIND_WITHDRAW) {
            _onWithdraw(m);
        } else {
            revert UnknownKind(k);
        }
    }

    function _onDeposit(bytes memory m) private {
        (bytes32 id, uint128 amount6) = Codec.decodeDeposit(m);
        Deposit storage d = deposits[id];
        if (d.lzSeen) revert DuplicateInstruction(id);
        d.lzSeen = true;
        d.lzAmount6 = amount6;
        budget[id] += msg.value;
        emit DepositNoted(id, amount6);
    }

    function _onPlace(bytes memory m) private {
        Codec.Place memory p = Codec.decodePlace(m);
        Route storage r = routes[p.routeId];
        if (r.status != ROUTE_NONE) revert DuplicateInstruction(p.routeId);
        budget[p.routeId] += msg.value;
        r.cloid = p.cloid;
        r.asset = p.asset;
        r.isBuy = p.isBuy;
        r.offerToken = p.offerToken;
        r.wantToken = p.wantToken;
        r.offerAmount = p.offerAmount;
        r.wantAmount = p.wantAmount;
        r.escrow = p.escrow;

        bytes32 reason = cancelledEarly[p.routeId] ? bytes32("CANCELLED") : checkPlace(p);
        if (reason != bytes32(0)) {
            // Nothing was taken from the ledger; closing with nothing drawn
            // releases the whole escrow back to the Veil order.
            r.status = ROUTE_REJECTED;
            r.seq = 1;
            Codec.FillItem[] memory items = new Codec.FillItem[](1);
            items[0] = Codec.FillItem(p.routeId, 1, 0, 0, true);
            bytes32[] memory payers = new bytes32[](1);
            payers[0] = p.routeId;
            _send(Codec.encodeFill(items), _lzReceiveOptions(fillGas + fillGasPerItem), payers);
            emit PlaceRejected(p.routeId, reason);
            return;
        }

        // The escrow's twins were burned on Starknet when the order was
        // routed; from here the HyperCore tokens back the order, not a twin.
        if (liability[p.offerToken] < p.escrow) revert LiabilityUnderflow(p.offerToken);
        liability[p.offerToken] -= p.escrow;
        r.status = ROUTE_OPEN;
        HyperCore.limitOrder(p.asset, p.isBuy, p.px, p.sz, false, p.tif, p.cloid);
        emit Placed(p.routeId, p.asset, p.isBuy, p.px, p.sz, p.tif);
    }

    function _onCancel(bytes memory m) private {
        bytes32 id = Codec.decodeCancel(m);
        budget[id] += msg.value;
        Route storage r = routes[id];
        if (r.status == ROUTE_OPEN) {
            HyperCore.cancelByCloid(r.asset, r.cloid);
            emit CancelSent(id);
        } else if (r.status == ROUTE_NONE) {
            cancelledEarly[id] = true;
        }
    }

    function _onWithdraw(bytes memory m) private {
        (bytes32 id, uint128 amount8) = Codec.decodeWithdraw(m);
        Exit storage e = exits[id];
        if (e.status != EXIT_NONE) revert DuplicateInstruction(id);
        require(amount8 != 0 && amount8 % USDC_CORE_PER_CCTP_UNIT == 0, "HV_EXIT_UNITS");
        budget[id] += msg.value;
        // The USDC twin was burned on Starknet before this was sent.
        if (liability[USDC_TOKEN] < amount8) revert LiabilityUnderflow(USDC_TOKEN);
        liability[USDC_TOKEN] -= amount8;
        e.amount8 = amount8;
        e.status = EXIT_REQUESTED;
        // HyperCore -> HyperEVM: HyperCore calls the USDC link's `transfer` for us.
        HyperCore.sendAsset(
            USDC_SYSTEM_ADDRESS, address(0), HyperCore.SPOT_DEX, HyperCore.SPOT_DEX, USDC_TOKEN, uint64(amount8)
        );
        emit ExitRequested(id, amount8);
    }

    /// Would every fill this order can produce respect the Veil order? Returns
    /// 0 if so, else the reason. `px`/`sz` are CoreWriter's 1e8 fixed point;
    /// amounts are HyperCore wei. A buy spends at most px*sz of the quote and
    /// receives the base net of the fee; a sell spends sz of the base and
    /// receives the quote net of the fee.
    function checkPlace(Codec.Place memory p) public view returns (bytes32) {
        if (p.tif < 1 || p.tif > 3) return "TIF";
        if (p.px == 0 || p.sz == 0 || p.cloid == 0) return "ZERO_FIELD";
        if (p.escrow == 0 || p.escrow > p.offerAmount || p.wantAmount == 0) return "ESCROW";
        if (p.asset < 10_000 || p.asset >= 100_000) return "NOT_SPOT";
        (bool okSpot, HyperCore.SpotInfo memory spot) = HyperCore.trySpotInfo(p.asset - 10_000);
        if (!okSpot) return "UNKNOWN_ASSET";
        uint64 base = spot.tokens[0];
        uint64 quote = spot.tokens[1];
        if (p.isBuy ? (p.wantToken != base || p.offerToken != quote) : (p.offerToken != base || p.wantToken != quote)) {
            return "PAIR";
        }
        (bool okBase, HyperCore.TokenInfo memory tb) = HyperCore.tryTokenInfo(uint32(base));
        (bool okQuote, HyperCore.TokenInfo memory tq) = HyperCore.tryTokenInfo(uint32(quote));
        if (!okBase || !okQuote) return "UNKNOWN_TOKEN";
        uint256 wb = 10 ** tb.weiDecimals;
        uint256 wq = 10 ** tq.weiDecimals;
        uint256 keep = 10_000 - maxFeeBps;
        if (p.isBuy) {
            if (uint256(p.px) * p.sz * wq > uint256(p.escrow) * 1e16) return "OVER_ESCROW";
            if (uint256(p.sz) * wb > uint256(p.wantAmount) * 1e8) return "OVER_WANT";
            if (uint256(p.px) * wq * p.wantAmount * 10_000 > wb * keep * p.offerAmount * 1e8) return "OVER_LIMIT";
        } else {
            if (uint256(p.sz) * wb > uint256(p.escrow) * 1e8) return "OVER_ESCROW";
            if (wb * p.wantAmount * 1e8 * 10_000 > uint256(p.px) * wq * keep * p.offerAmount) return "UNDER_LIMIT";
        }
        return bytes32(0);
    }

    // ------------------------------------------------------------------ deposits

    /// Relays Circle's attested CCTP message for one deposit (anyone may; only
    /// this contract can, as the message's destination caller) and moves the
    /// USDC to this contract's HyperCore spot account.
    function receiveDeposit(bytes calldata message, bytes calldata attestation) external returns (bytes32 id) {
        bytes memory m = message;
        if (m.length != CCTP_HOOK_DATA + 32) revert BadCctpMessage("LENGTH");
        if (Codec.readUint(m, CCTP_SOURCE_DOMAIN, 4) != STARKNET_DOMAIN) revert BadCctpMessage("DOMAIN");
        bytes32 self_ = bytes32(uint256(uint160(address(this))));
        if (bytes32(Codec.readUint(m, CCTP_DESTINATION_CALLER, 32)) != self_) revert BadCctpMessage("CALLER");
        if (bytes32(Codec.readUint(m, CCTP_MINT_RECIPIENT, 32)) != self_) revert BadCctpMessage("RECIPIENT");
        if (bytes32(Codec.readUint(m, CCTP_MESSAGE_SENDER, 32)) != entryHelper) revert BadCctpMessage("SENDER");
        id = bytes32(Codec.readUint(m, CCTP_HOOK_DATA, 32));
        Deposit storage d = deposits[id];
        if (d.cctpSeen) revert DuplicateInstruction(id);

        uint256 before = usdc.balanceOf(address(this));
        require(messageTransmitter.receiveMessage(message, attestation), "HV_CCTP_RECEIVE");
        uint256 arrived = usdc.balanceOf(address(this)) - before;
        if (arrived == 0 || arrived > type(uint128).max) revert BadCctpMessage("AMOUNT");
        d.cctpSeen = true;
        d.arrived6 = uint128(arrived);
        d.arrivedBlock = uint64(block.number);

        usdc.approve(address(coreDepositWallet), arrived);
        coreDepositWallet.deposit(arrived, HyperCore.SPOT_DEX);
        emit DepositArrived(id, arrived);
    }

    /// Once both halves of a deposit are here and the USDC has reached
    /// HyperCore (a later EVM block: precompiles read the state as of block
    /// construction), credits the twin on Starknet. Anyone may call; the
    /// deposit's budget pays.
    function creditDeposit(bytes32 id) external {
        Deposit storage d = deposits[id];
        if (!d.lzSeen || !d.cctpSeen || d.credited || block.number <= d.arrivedBlock) {
            revert DepositNotReady(id);
        }
        // CCTP never mints more than was burned; more than instructed is a bug.
        if (d.arrived6 > d.lzAmount6) revert BadCctpMessage("OVER_INSTRUCTED");
        d.credited = true;
        uint128 amount8 = uint128(uint256(d.arrived6) * USDC_CORE_PER_CCTP_UNIT);
        liability[USDC_TOKEN] += amount8;
        _assertSolvent(USDC_TOKEN);

        bytes32[] memory payers = new bytes32[](1);
        payers[0] = id;
        _send(Codec.encodeCredit(id, amount8), _lzReceiveOptions(creditGas), payers);
        _payKeeper(payers);
        emit DepositCredited(id, amount8);
    }

    // ------------------------------------------------------------------ fills

    /// The keeper's view of HyperCore, per route: cumulative spend and
    /// receipt, and whether the order is over. Every bound that does not need
    /// trust is enforced here.
    function report(Report[] calldata items) external onlyKeeper {
        uint256 n = items.length;
        require(n > 0, "HV_EMPTY_REPORT");
        Codec.FillItem[] memory out = new Codec.FillItem[](n);
        bytes32[] memory payers = new bytes32[](n);
        uint64[] memory touched = new uint64[](2 * n);
        uint256 t;

        for (uint256 i = 0; i < n; i++) {
            Report calldata it = items[i];
            Route storage r = routes[it.routeId];
            if (r.status != ROUTE_OPEN) revert RouteNotOpen(it.routeId);
            if (it.cumDraw < r.cumDraw || it.cumDeliver < r.cumDeliver) revert Regressed(it.routeId);
            if (it.cumDraw > r.escrow) revert OverEscrow(it.routeId);
            uint128 draw = it.cumDraw - r.cumDraw;
            uint128 deliver = it.cumDeliver - r.cumDeliver;
            if (deliver == 0 && draw != 0) revert DrawWithoutDelivery(it.routeId);
            if (deliver == 0 && !it.closed) revert EmptyReport(it.routeId);
            if (deliver != 0) {
                // The maker's limit price, for this execution on its own.
                if (uint256(draw) * r.wantAmount > uint256(deliver) * r.offerAmount) revert LimitPrice(it.routeId);
                liability[r.wantToken] += deliver;
                touched[t++] = r.wantToken;
            }
            r.cumDraw = it.cumDraw;
            r.cumDeliver = it.cumDeliver;
            r.seq += 1;
            if (it.closed) {
                // What was not spent goes back to the Veil order as twins.
                liability[r.offerToken] += r.escrow - r.cumDraw;
                touched[t++] = r.offerToken;
                r.status = ROUTE_CLOSED;
            }
            out[i] = Codec.FillItem(it.routeId, r.seq, r.cumDraw, r.cumDeliver, it.closed);
            payers[i] = it.routeId;
            emit Reported(it.routeId, r.seq, r.cumDraw, r.cumDeliver, it.closed);
        }
        for (uint256 j = 0; j < t; j++) {
            _assertSolvent(touched[j]);
        }
        _send(Codec.encodeFill(out), _lzReceiveOptions(fillGas + fillGasPerItem * uint128(n)), payers);
        _payKeeper(payers);
    }

    /// Emergency cancel of a route's HyperCore order, without a Starknet
    /// instruction. The route stays open until the keeper reports it closed.
    function cancelOnCore(bytes32 routeId) external onlyKeeper {
        Route storage r = routes[routeId];
        if (r.status != ROUTE_OPEN) revert RouteNotOpen(routeId);
        HyperCore.cancelByCloid(r.asset, r.cloid);
        emit CancelSent(routeId);
    }

    // ------------------------------------------------------------------ exits

    /// Once an exit's USDC has reached this contract on HyperEVM, burns it
    /// through CCTP to the Starknet exit vault, tagged with the exit id.
    /// Anyone may call; the exit's budget pays the caller's fee.
    function burnExit(bytes32 id) external {
        Exit storage e = exits[id];
        if (e.status != EXIT_REQUESTED) revert ExitNotReady(id);
        uint256 amount6 = uint256(e.amount8) / USDC_CORE_PER_CCTP_UNIT;
        if (usdc.balanceOf(address(this)) < amount6) revert ExitNotReady(id);
        e.status = EXIT_BURNED;
        usdc.approve(address(tokenMessenger), amount6);
        tokenMessenger.depositForBurnWithHook(
            amount6,
            STARKNET_DOMAIN,
            exitVault,
            address(usdc),
            exitVault,
            exitCctpMaxFee,
            exitMinFinality,
            abi.encodePacked(id)
        );
        bytes32[] memory payers = new bytes32[](1);
        payers[0] = id;
        _payKeeper(payers);
        emit ExitBurned(id, amount6);
    }

    // ------------------------------------------------------------------ budgets

    function fundBudget(bytes32 id) external payable {
        budget[id] += msg.value;
        emit BudgetFunded(id, msg.value);
    }

    function _take(bytes32[] memory payers, uint256 amount) private returns (uint256 taken) {
        for (uint256 i = 0; i < payers.length && taken < amount; i++) {
            uint256 have = budget[payers[i]];
            uint256 use = have < amount - taken ? have : amount - taken;
            budget[payers[i]] = have - use;
            taken += use;
        }
    }

    function _send(bytes memory message, bytes memory options, bytes32[] memory payers) private {
        uint256 fee = _quote(starknetEid, message, options).nativeFee;
        uint256 taken = _take(payers, fee);
        if (taken < fee) revert BudgetTooLow(fee, taken);
        _lzSendValue(starknetEid, message, options, fee);
    }

    function _payKeeper(bytes32[] memory payers) private {
        if (keeperFee == 0) return;
        uint256 paid = _take(payers, keeperFee);
        if (paid != 0) {
            (bool ok,) = msg.sender.call{value: paid}("");
            require(ok, "HV_KEEPER_FEE");
        }
    }

    // ------------------------------------------------------------------ solvency

    function _assertSolvent(uint64 token) private view {
        uint256 held = HyperCore.spotBalance(address(this), token).total;
        if (held < liability[token]) revert Insolvent(token, held, liability[token]);
    }

    /// HyperCore balance and twins outstanding, for monitoring.
    function solvency(uint64 token) external view returns (uint256 held, uint256 owed) {
        held = HyperCore.spotBalance(address(this), token).total;
        owed = liability[token];
    }

    // ------------------------------------------------------------------ admin

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit ConfigSet("keeper", uint256(uint160(keeper_)));
    }

    function setEntryHelper(bytes32 entryHelper_) external onlyOwner {
        entryHelper = entryHelper_;
        emit ConfigSet("entryHelper", uint256(entryHelper_));
    }

    function setExitVault(bytes32 exitVault_) external onlyOwner {
        exitVault = exitVault_;
        emit ConfigSet("exitVault", uint256(exitVault_));
    }

    function setMaxFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS_CEILING) revert BadConfig();
        maxFeeBps = bps;
        emit ConfigSet("maxFeeBps", bps);
    }

    function setExitCctp(uint256 maxFee, uint32 minFinality) external onlyOwner {
        exitCctpMaxFee = maxFee;
        exitMinFinality = minFinality;
        emit ConfigSet("exitCctpMaxFee", maxFee);
        emit ConfigSet("exitMinFinality", minFinality);
    }

    function setGas(uint128 credit, uint128 fillBase, uint128 fillPerItem) external onlyOwner {
        if (credit == 0 || fillPerItem == 0) revert BadConfig();
        creditGas = credit;
        fillGas = fillBase;
        fillGasPerItem = fillPerItem;
        emit ConfigSet("creditGas", credit);
        emit ConfigSet("fillGas", fillBase);
        emit ConfigSet("fillGasPerItem", fillPerItem);
    }

    function setKeeperFee(uint256 fee) external onlyOwner {
        keeperFee = fee;
        emit ConfigSet("keeperFee", fee);
    }

    /// HyperCore account mode. 1 = standard ("disabled" abstraction): no
    /// unified-account daily action cap.
    function setAbstraction(uint8 mode) external onlyOwner {
        HyperCore.setAbstraction(address(this), mode);
        emit ConfigSet("abstraction", mode);
    }
}
