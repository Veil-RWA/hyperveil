// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TEST ONLY. Stand-ins for what the omnibus talks to on HyperEVM: the LayerZero
// endpoint, HyperCore (the CoreWriter system contract and the read
// precompiles, placed at their real addresses by `deployAt`), and Circle's
// USDC, CCTP and CoreDepositWallet. Each reproduces the behaviour the omnibus
// relies on, read from the real source (see contracts/cctp/ICctp.sol and
// contracts/hyperliquid/HyperCore.sol for where).

import {HyperCore} from "contracts/hyperliquid/HyperCore.sol";
import {HyperVeilCodec as Codec} from "contracts/HyperVeilCodec.sol";
import {ILayerZeroReceiver, MessagingFee, MessagingParams, MessagingReceipt, Origin} from "contracts/lz/ILayerZeroEndpointV2.sol";

contract MockEndpoint {
    uint256 public fee;
    uint32 public lastDstEid;
    bytes32 public lastReceiver;
    bytes public lastMessage;
    bytes public lastOptions;
    uint256 public lastValue;
    uint256 public sendCount;
    uint64 public nonce;

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee(fee, 0);
    }

    function send(MessagingParams calldata p, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory r)
    {
        require(msg.value >= fee, "MOCK_FEE_NOT_PAID");
        lastDstEid = p.dstEid;
        lastReceiver = p.receiver;
        lastMessage = p.message;
        lastOptions = p.options;
        lastValue = msg.value;
        sendCount++;
        nonce++;
        if (msg.value > fee) {
            (bool ok,) = refundAddress.call{value: msg.value - fee}("");
            require(ok, "MOCK_REFUND");
        }
        r.nonce = nonce;
        r.fee = MessagingFee(fee, 0);
    }

    function setDelegate(address) external {}

    /// Delivers `message` to `oapp` as the endpoint would, with `msg.value` as
    /// the executor's native drop.
    function deliver(address oapp, uint32 srcEid, bytes32 sender, bytes calldata message) external payable {
        nonce++;
        ILayerZeroReceiver(oapp).lzReceive{value: msg.value}(
            Origin(srcEid, sender, nonce), bytes32(uint256(nonce)), message, address(this), ""
        );
    }
}

/// At 0x3333...3333. Records every raw action.
contract MockCoreWriter {
    bytes[] public actions;
    address[] public senders;

    event RawAction(address indexed user, bytes data);

    function sendRawAction(bytes calldata data) external {
        actions.push(data);
        senders.push(msg.sender);
        emit RawAction(msg.sender, data);
    }

    function actionCount() external view returns (uint256) {
        return actions.length;
    }

    function lastAction() external view returns (bytes memory) {
        return actions[actions.length - 1];
    }
}

/// At 0x...0801. `abi.encode(user, token)` -> SpotBalance.
contract MockSpotBalance {
    mapping(address => mapping(uint64 => uint64)) public total;

    function set(address user, uint64 token, uint64 amount) external {
        total[user][token] = amount;
    }

    function credit(address user, uint64 token, uint64 amount) external {
        total[user][token] += amount;
    }

    function debit(address user, uint64 token, uint64 amount) external {
        total[user][token] -= amount;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        (address user, uint64 token) = abi.decode(input, (address, uint64));
        return abi.encode(HyperCore.SpotBalance(total[user][token], 0, 0));
    }
}

/// At 0x...080b. `abi.encode(spot)` -> SpotInfo; an unknown spot errors, as
/// the real precompile does on an invalid input.
contract MockSpotInfo {
    mapping(uint32 => uint64[2]) public tokens;
    mapping(uint32 => bool) public known;

    function setSpot(uint32 spot, uint64 base, uint64 quote) external {
        tokens[spot] = [base, quote];
        known[spot] = true;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        uint32 spot = abi.decode(input, (uint32));
        require(known[spot], "invalid spot");
        return abi.encode(HyperCore.SpotInfo("PAIR", tokens[spot]));
    }
}

/// At 0x...080C. `abi.encode(token)` -> TokenInfo.
contract MockTokenInfo {
    mapping(uint32 => uint8) public szDecimals;
    mapping(uint32 => uint8) public weiDecimals;
    mapping(uint32 => bool) public known;

    function setToken(uint32 token, uint8 sz, uint8 wei_) external {
        szDecimals[token] = sz;
        weiDecimals[token] = wei_;
        known[token] = true;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        uint32 token = abi.decode(input, (uint32));
        require(known[token], "invalid token");
        return abi.encode(
            HyperCore.TokenInfo("TKN", new uint64[](0), 0, address(0), address(0), szDecimals[token], weiDecimals[token], 0)
        );
    }
}

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// CCTP MessageTransmitterV2: checks the destination caller, mints
/// `amount - feeExecuted` to the mint recipient, once per message.
contract MockMessageTransmitter {
    MockUSDC public immutable usdc;
    mapping(bytes32 => bool) public used;

    constructor(MockUSDC usdc_) {
        usdc = usdc_;
    }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool) {
        require(keccak256(attestation) == keccak256("ATTESTED"), "MOCK_BAD_ATTESTATION");
        bytes memory m = message;
        address caller = address(uint160(Codec.readUint(m, 108, 32)));
        require(caller == address(0) || caller == msg.sender, "MOCK_WRONG_DESTINATION_CALLER");
        require(!used[keccak256(m)], "MOCK_NONCE_USED");
        used[keccak256(m)] = true;
        address recipient = address(uint160(Codec.readUint(m, 148 + 36, 32)));
        uint256 amount = Codec.readUint(m, 148 + 68, 32);
        uint256 feeExecuted = Codec.readUint(m, 148 + 164, 32);
        usdc.mint(recipient, amount - feeExecuted);
        return true;
    }
}

/// CCTP TokenMessengerV2: pulls ("burns") and records the call.
contract MockTokenMessenger {
    MockUSDC public immutable usdc;
    uint256 public lastAmount;
    uint32 public lastDomain;
    bytes32 public lastMintRecipient;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    uint32 public lastMinFinality;
    bytes public lastHookData;
    uint256 public burnCount;

    constructor(MockUSDC usdc_) {
        usdc = usdc_;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(burnToken == address(usdc), "MOCK_BURN_TOKEN");
        require(hookData.length > 0, "Hook data is empty");
        usdc.transferFrom(msg.sender, address(this), amount);
        lastAmount = amount;
        lastDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinality = minFinalityThreshold;
        lastHookData = hookData;
        burnCount++;
    }
}

/// Circle's CoreDepositWallet: `deposit` credits the caller on HyperCore spot
/// (6 -> 8 decimals); `transfer` is how HyperCore pays out to the EVM, called
/// by USDC's system address.
contract MockCoreDepositWallet {
    address public constant SYSTEM = 0x2000000000000000000000000000000000000000;
    MockUSDC public immutable usdc;
    MockSpotBalance public immutable core;

    constructor(MockUSDC usdc_, MockSpotBalance core_) {
        usdc = usdc_;
        core = core_;
    }

    function deposit(uint256 amount, uint32 destinationDex) external {
        require(destinationDex == type(uint32).max, "MOCK_NOT_SPOT");
        usdc.transferFrom(msg.sender, address(this), amount);
        core.credit(msg.sender, 0, uint64(amount * 100));
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(msg.sender == SYSTEM, "Caller is not the system address");
        return usdc.transfer(to, amount);
    }
}

/// Exposes the codec library for the wire-format vectors.
contract CodecHarness {
    function encodeDeposit(bytes32 id, uint128 amount) external pure returns (bytes memory) {
        return Codec.encodeDeposit(id, amount);
    }

    function decodeDeposit(bytes calldata b) external pure returns (bytes32, uint128) {
        return Codec.decodeDeposit(b);
    }

    function encodePlace(Codec.Place calldata p) external pure returns (bytes memory) {
        return Codec.encodePlace(p);
    }

    function decodePlace(bytes calldata b) external pure returns (Codec.Place memory) {
        return Codec.decodePlace(b);
    }

    function encodeCancel(bytes32 id) external pure returns (bytes memory) {
        return Codec.encodeCancel(id);
    }

    function encodeWithdraw(bytes32 id, uint128 amount) external pure returns (bytes memory) {
        return Codec.encodeWithdraw(id, amount);
    }

    function encodeCredit(bytes32 id, uint128 amount) external pure returns (bytes memory) {
        return Codec.encodeCredit(id, amount);
    }

    function encodeFill(Codec.FillItem[] calldata items) external pure returns (bytes memory) {
        return Codec.encodeFill(items);
    }

    function decodeFill(bytes calldata b) external pure returns (Codec.FillItem[] memory) {
        return Codec.decodeFill(b);
    }
}
