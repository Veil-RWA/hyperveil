// HyperVeilGateway — the Starknet end of HyperVeil: a LayerZero app talking to
// the omnibus on HyperEVM, and the Veil pool's external venue.
//
// Four jobs, all of them bookkeeping around one invariant: a twin exists only
// while the omnibus holds its HyperCore token.
//
//  * Deposits. The user holds real USDC inside the Veil pool. A proven pool
//    `invoke` pays it to the entry helper, which burns it through CCTP and
//    registers the deposit here, naming the USDC-twin open note it should land
//    in. The DEPOSIT message tells the omnibus; when the omnibus has both the
//    USDC and the message it answers CREDIT, and only then is the USDC twin
//    minted into the note.
//  * Routing. The keeper (the pool's exchange) crosses what it can inside the
//    pool; an order it cannot cross is routed here. The pool hands over the
//    order's escrow, which is burned (the omnibus's HyperCore tokens stop
//    backing it: they are about to be spent), and PLACE asks the omnibus to
//    trade it on HyperCore.
//  * Fills. The omnibus reports executions as FILL (cumulative per route).
//    Each new execution becomes a receipt: its `deliver` is minted into this
//    contract's custody, approved to the pool, and applied to the maker's
//    receive note by the exchange's proven `venue_fill`. When the omnibus
//    reports the route closed and every receipt is applied, `release` mints the
//    unspent escrow back and returns it to the order.
//  * Exits. The user proves a pool `invoke` with this contract as the adapter:
//    in one transaction the pool pays it the USDC twin and calls
//    `privacy_invoke`, which burns the exit amount, registers the exit with
//    the vault and sends WITHDRAW, then hands 1 unit back as change into the
//    user's open note (an invoke must return something). The omnibus sends the
//    USDC through CCTP to the exit vault, which fills the real-USDC open note
//    the exit named, inside the same Veil pool.
//
// Fees. The user pays every message, in STRK held inside the Veil pool, so no
// payment ties a public wallet to an order or an exit: a proven pool `invoke`
// pays the fee adapter, which prepays the gateway. A route's and a cancel's
// fee is prepaid against the order (`fund_order`); a deposit's against the
// USDC-twin note it will credit, and an exit's against the USDC note it will
// fill (`fund_note`). A credit can only ever pay for the thing it is keyed by.
// Each outbound message can also carry HYPE to HyperEVM (`return_value`),
// which pays the omnibus's reply.
//
// Never revert on a policy outcome inside `lz_receive`: a CREDIT whose note
// refuses is quarantined and retried later. Protocol errors (unknown kind, a
// report that goes backwards, a route we never sent) do revert — they are bugs,
// and a stuck message is how one gets noticed.

use starknet::ContractAddress;
use super::lz::{Bytes32, MessagingFee};

pub const USDC_CORE_TOKEN: u64 = 0;
/// HyperCore USDC has 8 decimals, CCTP USDC 6.
pub const USDC_CORE_PER_CCTP_UNIT: u128 = 100;

pub const DEPOSIT_NONE: u8 = 0;
pub const DEPOSIT_SENT: u8 = 1;
pub const DEPOSIT_CREDITED: u8 = 2;
pub const DEPOSIT_QUARANTINED: u8 = 3;

pub const ROUTE_NONE: u8 = 0;
pub const ROUTE_OPEN: u8 = 1;
pub const ROUTE_CLOSED: u8 = 2;
pub const ROUTE_RELEASED: u8 = 3;

#[derive(Copy, Drop, Serde, PartialEq, Debug, Default, starknet::Store)]
pub struct DepositRecord {
    pub note_id: felt252,
    pub amount_usdc6: u128,
    /// What the omnibus credited (twin units); set once CREDIT arrives.
    pub credited: u128,
    pub status: u8,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct RouteRecord {
    pub order_id: felt252,
    pub status: u8,
    pub escrow: u128,
    pub cum_draw: u128,
    pub cum_deliver: u128,
    pub seq: u64,
    pub pending_receipts: u32,
    pub offer_twin: ContractAddress,
    pub want_twin: ContractAddress,
    pub cancel_requested: bool,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug, Default, starknet::Store)]
pub struct ReceiptRecord {
    pub route_id: felt252,
    pub order_id: felt252,
    pub draw: u128,
    pub deliver: u128,
    pub pending: bool,
}

/// The per-kind `lzReceive` gas limit on HyperEVM. Owner-set; zero means the
/// kind has not been configured and nothing of it can be sent.
#[starknet::interface]
pub trait IHyperVeilGateway<TContractState> {
    // ── Deposits ────────────────────────────────────────────────────────────
    /// Entry helper only. Claims `note_id` (a USDC-twin open note in the pool)
    /// for this deposit and tells the omnibus. Returns the deposit id, which the
    /// helper puts in the CCTP hook data. The DEPOSIT fee is paid from the
    /// STRK prepaid against `note_id` (`fund_note`).
    fn register_deposit(
        ref self: TContractState, note_id: felt252, amount_usdc6: u128, return_value: u128,
    ) -> felt252;
    fn quote_deposit(
        self: @TContractState, note_id: felt252, amount_usdc6: u128, return_value: u128,
    ) -> MessagingFee;
    /// Permissionless. Delivers a quarantined credit into its note.
    fn retry_credit(ref self: TContractState, deposit_id: felt252);

    // ── Orders ──────────────────────────────────────────────────────────────
    /// Anyone. Prepays STRK for the messages an order's routing will need.
    fn fund_order(ref self: TContractState, order_id: felt252, amount: u256);
    /// Keeper only. Takes the order's escrow from the pool and asks the omnibus
    /// to place it on HyperCore as spot `asset` at `px`/`sz`, `tif`.
    fn route_order(
        ref self: TContractState,
        order_id: felt252,
        asset: u32,
        is_buy: bool,
        px: u64,
        sz: u64,
        tif: u8,
        return_value: u128,
        fee: MessagingFee,
    ) -> felt252;
    /// Keeper, or anyone once the pool order has expired. Asks the omnibus to
    /// cancel the HyperCore order; it answers with a closing FILL.
    fn cancel_route(
        ref self: TContractState, order_id: felt252, return_value: u128, fee: MessagingFee,
    );
    /// Permissionless. Once the route is closed and every receipt applied,
    /// returns the unspent escrow to the order.
    fn release(ref self: TContractState, order_id: felt252);
    /// The LayerZero fee `route_order` would pay now (the PLACE it would send).
    fn quote_route(
        self: @TContractState,
        order_id: felt252,
        asset: u32,
        is_buy: bool,
        px: u64,
        sz: u64,
        tif: u8,
        return_value: u128,
    ) -> MessagingFee;
    fn quote_cancel(self: @TContractState, order_id: felt252, return_value: u128) -> MessagingFee;

    // ── Deposits and exits: fees ────────────────────────────────────────────
    /// Anyone. Prepays STRK for the message of the deposit that credits
    /// `note_id` (a USDC-twin open note) or of the exit that fills it (a USDC
    /// open note). Keyed by the note, so the credit can only ever pay for a
    /// deposit or an exit that pays that note.
    fn fund_note(ref self: TContractState, note_id: felt252, amount: u256);
    fn note_credit(self: @TContractState, note_id: felt252) -> u256;
    fn quote_exit(self: @TContractState, amount: u128, return_value: u128) -> MessagingFee;

    // ── Views ───────────────────────────────────────────────────────────────
    fn deposit_of(self: @TContractState, deposit_id: felt252) -> DepositRecord;
    fn deposit_of_note(self: @TContractState, note_id: felt252) -> felt252;
    fn route_of(self: @TContractState, route_id: felt252) -> RouteRecord;
    fn current_route(self: @TContractState, order_id: felt252) -> felt252;
    fn receipt_of(self: @TContractState, receipt_id: felt252) -> ReceiptRecord;
    fn order_credit(self: @TContractState, order_id: felt252) -> u256;
    fn reserved(self: @TContractState, twin: ContractAddress) -> u256;
    fn twin_of(self: @TContractState, core_token: u64) -> ContractAddress;
    fn core_token_of(self: @TContractState, twin: ContractAddress) -> u64;

    // ── Admin ───────────────────────────────────────────────────────────────
    fn set_peer(ref self: TContractState, eid: u32, peer: Bytes32);
    fn get_peer(self: @TContractState, eid: u32) -> Bytes32;
    fn set_delegate(ref self: TContractState, delegate: ContractAddress);
    fn set_twin(ref self: TContractState, core_token: u64, twin: ContractAddress);
    fn set_pool(ref self: TContractState, pool: ContractAddress);
    fn set_keeper(ref self: TContractState, keeper: ContractAddress);
    fn set_entry_helper(ref self: TContractState, entry_helper: ContractAddress);
    fn set_exit_vault(ref self: TContractState, exit_vault: ContractAddress);
    fn set_gas(ref self: TContractState, kind: u8, gas: u128);
    fn get_gas(self: @TContractState, kind: u8) -> u128;
    fn pool(self: @TContractState) -> ContractAddress;
    fn keeper(self: @TContractState) -> ContractAddress;
    fn entry_helper(self: @TContractState) -> ContractAddress;
    fn exit_vault(self: @TContractState) -> ContractAddress;
    fn dst_eid(self: @TContractState) -> u32;
    /// The token LayerZero fees are paid in (STRK).
    fn native_token(self: @TContractState) -> ContractAddress;
    fn owner(self: @TContractState) -> ContractAddress;
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
}

/// The gateway as the Veil pool's invoke adapter for exits. The pool has
/// just paid it `exit_amount + 1` of the USDC twin; it burns `exit_amount`,
/// registers the exit for `usdc_note_id` (the user's empty real-USDC open
/// note in the same pool) and returns the 1 unit into `open_note_id`.
#[starknet::interface]
pub trait IHyperVeilExitAdapter<TContractState> {
    fn privacy_invoke(
        ref self: TContractState,
        open_note_id: felt252,
        exit_amount: u128,
        usdc_note_id: felt252,
        return_value: u128,
    ) -> Array<crate::interfaces::OpenNoteDeposit>;
}

/// What the exit vault needs to hear from the gateway.
#[starknet::interface]
pub trait IExitRegistry<TContractState> {
    fn register_exit(
        ref self: TContractState, exit_id: felt252, note_id: felt252, amount_usdc6: u128,
    );
}

#[starknet::contract]
pub mod HyperVeilGateway {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{
        ContractAddress, SyscallResultTrait, get_block_timestamp, get_caller_address,
        get_contract_address,
    };
    use crate::codec::{
        FillItem, KIND_CANCEL, KIND_CREDIT, KIND_DEPOSIT, KIND_FILL, KIND_PLACE, KIND_WITHDRAW,
        Place, decode_credit, decode_fill, encode_cancel, encode_deposit, encode_place,
        encode_withdraw, kind,
    };
    use crate::interfaces::{
        IERC20Dispatcher, IERC20DispatcherTrait, IHyperVeilTwinMintDispatcher,
        IHyperVeilTwinMintDispatcherTrait, IVeilPoolDispatcher, IVeilPoolDispatcherTrait,
        IVeilVenue, ORDER_OPEN, OpenNoteDeposit, VenueReceipt,
    };
    use crate::lz::{
        Bytes32, IEndpointV2Dispatcher, IEndpointV2DispatcherTrait, ILayerZeroReceiver,
        MessageReceipt, MessagingFee, MessagingParams, Origin, build_lz_receive_options,
    };
    use super::{
        DEPOSIT_CREDITED, DEPOSIT_QUARANTINED, DEPOSIT_SENT, DepositRecord,
        IExitRegistryDispatcher, IExitRegistryDispatcherTrait, IHyperVeilExitAdapter,
        IHyperVeilGateway, ROUTE_CLOSED,
        ROUTE_NONE, ROUTE_OPEN, ROUTE_RELEASED, ReceiptRecord, RouteRecord, USDC_CORE_PER_CCTP_UNIT,
        USDC_CORE_TOKEN,
    };

    // An empty open note in the pool: salt 1 in the high 128 bits, amount 0.
    const EMPTY_OPEN_NOTE: felt252 = 0x100000000000000000000000000000000;
    const DOMAIN_DEPOSIT: felt252 = 'HV_DEPOSIT';
    const DOMAIN_ROUTE: felt252 = 'HV_ROUTE';
    const DOMAIN_RECEIPT: felt252 = 'HV_RECEIPT';
    const DOMAIN_EXIT: felt252 = 'HV_EXIT';
    /// What an exit hands back into the user's open note: a pool invoke must
    /// return a non-zero deposit.
    const EXIT_CHANGE: u128 = 1;

    /// Where a message's fee comes from besides the caller.
    #[derive(Copy, Drop)]
    enum Credit {
        None,
        Order: felt252,
        Note: felt252,
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        endpoint: ContractAddress,
        /// Fee token the endpoint charges in (STRK).
        native_token: ContractAddress,
        dst_eid: u32,
        peers: Map<u32, Bytes32>,
        gas: Map<u8, u128>,
        pool: ContractAddress,
        keeper: ContractAddress,
        entry_helper: ContractAddress,
        exit_vault: ContractAddress,
        /// HyperCore token index -> twin, and back (stored +1 so 0 = unset).
        twins: Map<u64, ContractAddress>,
        core_token_plus_one: Map<ContractAddress, u64>,
        deposits: Map<felt252, DepositRecord>,
        note_deposit: Map<felt252, felt252>,
        routes: Map<felt252, RouteRecord>,
        order_round: Map<felt252, u32>,
        current_route: Map<felt252, felt252>,
        receipts: Map<felt252, ReceiptRecord>,
        /// Twin held here for the pool to pull (unapplied receipts), per twin.
        reserved: Map<ContractAddress, u256>,
        order_credit: Map<felt252, u256>,
        note_credit: Map<felt252, u256>,
        exit_nonce: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        DepositRegistered: DepositRegistered,
        DepositCredited: DepositCredited,
        CreditQuarantined: CreditQuarantined,
        OrderFunded: OrderFunded,
        NoteFunded: NoteFunded,
        OrderRouted: OrderRouted,
        CancelRequested: CancelRequested,
        ReceiptCreated: ReceiptCreated,
        RouteClosed: RouteClosed,
        RouteReleased: RouteReleased,
        ExitRequested: ExitRequested,
        TwinSet: TwinSet,
        PeerSet: PeerSet,
        ConfigSet: ConfigSet,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DepositRegistered {
        #[key]
        pub deposit_id: felt252,
        pub note_id: felt252,
        pub amount_usdc6: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DepositCredited {
        #[key]
        pub deposit_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CreditQuarantined {
        #[key]
        pub deposit_id: felt252,
        pub amount: u128,
        pub reason: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OrderFunded {
        #[key]
        pub order_id: felt252,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct NoteFunded {
        #[key]
        pub note_id: felt252,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OrderRouted {
        #[key]
        pub order_id: felt252,
        #[key]
        pub route_id: felt252,
        pub escrow: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CancelRequested {
        #[key]
        pub route_id: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ReceiptCreated {
        #[key]
        pub receipt_id: felt252,
        #[key]
        pub route_id: felt252,
        pub draw: u128,
        pub deliver: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RouteClosed {
        #[key]
        pub route_id: felt252,
        pub cum_draw: u128,
        pub cum_deliver: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RouteReleased {
        #[key]
        pub order_id: felt252,
        #[key]
        pub route_id: felt252,
        pub refund: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ExitRequested {
        #[key]
        pub exit_id: felt252,
        pub note_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct TwinSet {
        #[key]
        pub core_token: u64,
        pub twin: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PeerSet {
        #[key]
        pub eid: u32,
        pub peer: Bytes32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ConfigSet {
        #[key]
        pub what: felt252,
        pub value: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferred {
        pub previous_owner: ContractAddress,
        pub new_owner: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        endpoint: ContractAddress,
        native_token: ContractAddress,
        dst_eid: u32,
        pool: ContractAddress,
    ) {
        assert(!owner.is_zero(), 'ZERO_OWNER');
        assert(!endpoint.is_zero(), 'ZERO_ENDPOINT');
        assert(!native_token.is_zero(), 'ZERO_NATIVE_TOKEN');
        assert(!pool.is_zero(), 'ZERO_POOL');
        self.owner.write(owner);
        self.endpoint.write(endpoint);
        self.native_token.write(native_token);
        self.dst_eid.write(dst_eid);
        self.pool.write(pool);
    }

    // ── LayerZero receiver ──────────────────────────────────────────────────
    #[abi(embed_v0)]
    impl LayerZeroReceiverImpl of ILayerZeroReceiver<ContractState> {
        fn lz_receive(
            ref self: ContractState,
            origin: Origin,
            guid: Bytes32,
            message: ByteArray,
            executor: ContractAddress,
            extra_data: ByteArray,
            value: u256,
        ) {
            assert(get_caller_address() == self.endpoint.read(), 'ONLY_ENDPOINT');
            let expected = self.peers.read(origin.src_eid);
            assert(expected.value != 0, 'NO_PEER');
            assert(expected == origin.sender, 'ONLY_PEER');

            let message_kind = kind(@message);
            if message_kind == KIND_CREDIT {
                let (deposit_id, amount) = decode_credit(@message);
                self.handle_credit(deposit_id, amount);
            } else if message_kind == KIND_FILL {
                for item in decode_fill(@message) {
                    self.handle_fill(item);
                }
            } else {
                panic!("HV_UNKNOWN_KIND");
            }
        }

        fn allow_initialize_path(self: @ContractState, origin: Origin) -> bool {
            let peer = self.peers.read(origin.src_eid);
            peer.value != 0 && peer == origin.sender
        }

        /// 0 = unordered. Reports carry their own per-route sequence.
        fn next_nonce(self: @ContractState, src_eid: u32, sender: Bytes32) -> u64 {
            0
        }
    }

    // ── The pool's venue surface ────────────────────────────────────────────
    #[abi(embed_v0)]
    impl VenueImpl of IVeilVenue<ContractState> {
        fn venue_receipt(self: @ContractState, receipt_id: felt252) -> VenueReceipt {
            let r = self.receipts.read(receipt_id);
            VenueReceipt {
                order_id: r.order_id, draw: r.draw, deliver: r.deliver, pending: r.pending,
            }
        }

        // The pool has just pulled `deliver`; the receipt is spent. Release is
        // NOT attempted here: this runs inside the pool's reentrancy guard.
        fn consume_venue_receipt(ref self: ContractState, receipt_id: felt252) {
            assert(get_caller_address() == self.pool.read(), 'ONLY_POOL');
            let mut receipt = self.receipts.read(receipt_id);
            assert(receipt.pending, 'HV_RECEIPT_NOT_PENDING');
            receipt.pending = false;
            self.receipts.write(receipt_id, receipt);
            let mut route = self.routes.read(receipt.route_id);
            route.pending_receipts -= 1;
            self.routes.write(receipt.route_id, route);
            let twin = route.want_twin;
            self.reserved.write(twin, self.reserved.read(twin) - receipt.deliver.into());
        }
    }

    #[abi(embed_v0)]
    impl GatewayImpl of IHyperVeilGateway<ContractState> {
        // ── Deposits ────────────────────────────────────────────────────────
        fn register_deposit(
            ref self: ContractState, note_id: felt252, amount_usdc6: u128, return_value: u128,
        ) -> felt252 {
            assert(get_caller_address() == self.entry_helper.read(), 'ONLY_ENTRY_HELPER');
            assert(amount_usdc6 != 0, 'ZERO_AMOUNT');
            let deposit_id = self.check_deposit_note(note_id);

            self
                .deposits
                .write(
                    deposit_id,
                    DepositRecord { note_id, amount_usdc6, credited: 0, status: DEPOSIT_SENT },
                );
            self.note_deposit.write(note_id, deposit_id);

            // Paid from the note's prepaid credit: the pool and the helper
            // cannot pay, and nothing else may.
            let message = encode_deposit(deposit_id, amount_usdc6);
            let fee = self.lz_quote(KIND_DEPOSIT, message.clone(), return_value);
            self
                .lz_send(
                    KIND_DEPOSIT, message, return_value, fee, Zero::zero(), Credit::Note(note_id),
                );
            self.emit(DepositRegistered { deposit_id, note_id, amount_usdc6 });
            deposit_id
        }

        fn quote_deposit(
            self: @ContractState, note_id: felt252, amount_usdc6: u128, return_value: u128,
        ) -> MessagingFee {
            let deposit_id = deposit_id_of(self.pool.read(), note_id);
            self.lz_quote(KIND_DEPOSIT, encode_deposit(deposit_id, amount_usdc6), return_value)
        }

        fn retry_credit(ref self: ContractState, deposit_id: felt252) {
            let mut deposit = self.deposits.read(deposit_id);
            assert(deposit.status == DEPOSIT_QUARANTINED, 'HV_NOT_QUARANTINED');
            // Outside `lz_receive` a failure may revert: nothing was spent to
            // get here, and the credit stays quarantined for another try.
            deposit.status = DEPOSIT_CREDITED;
            self.deposits.write(deposit_id, deposit);
            let twin = self.usdc_twin();
            self.mint_into_pool_note(twin, deposit.note_id, deposit.credited, true);
            self.emit(DepositCredited { deposit_id, amount: deposit.credited });
        }

        // ── Orders ──────────────────────────────────────────────────────────
        fn fund_order(ref self: ContractState, order_id: felt252, amount: u256) {
            assert(amount != 0, 'ZERO_AMOUNT');
            let native = IERC20Dispatcher { contract_address: self.native_token.read() };
            assert(
                native.transfer_from(get_caller_address(), get_contract_address(), amount),
                'FEE_TRANSFER_FAILED',
            );
            self.order_credit.write(order_id, self.order_credit.read(order_id) + amount);
            self.emit(OrderFunded { order_id, amount });
        }

        fn route_order(
            ref self: ContractState,
            order_id: felt252,
            asset: u32,
            is_buy: bool,
            px: u64,
            sz: u64,
            tif: u8,
            return_value: u128,
            fee: MessagingFee,
        ) -> felt252 {
            let caller = get_caller_address();
            assert(caller == self.keeper.read(), 'ONLY_KEEPER');
            let pool = IVeilPoolDispatcher { contract_address: self.pool.read() };
            let order = pool.get_order(order_id);
            assert(order.maker_commitment != 0, 'HV_NO_ORDER');
            assert(order.status == ORDER_OPEN, 'HV_ORDER_NOT_OPEN');
            let offer_token = self.core_token_of(order.offer_token);
            let want_token = self.core_token_of(order.want_token);

            let round = self.order_round.read(order_id) + 1;
            let route_id = poseidon_hash_span(
                array![DOMAIN_ROUTE, order_id, round.into()].span(),
            );
            assert(self.routes.read(route_id).status == ROUTE_NONE, 'HV_ROUTE_EXISTS');

            // The escrow leaves the pool for this contract and is burned: from
            // here on the omnibus's HyperCore tokens back the order on
            // Hyperliquid, not a twin on Starknet.
            let escrow = pool.venue_route(order_id);
            IHyperVeilTwinMintDispatcher { contract_address: order.offer_token }
                .burn(get_contract_address(), escrow.into());

            self.order_round.write(order_id, round);
            self.current_route.write(order_id, route_id);
            self
                .routes
                .write(
                    route_id,
                    RouteRecord {
                        order_id,
                        status: ROUTE_OPEN,
                        escrow,
                        cum_draw: 0,
                        cum_deliver: 0,
                        seq: 0,
                        pending_receipts: 0,
                        offer_twin: order.offer_token,
                        want_twin: order.want_token,
                        cancel_requested: false,
                    },
                );

            let message = encode_place(
                @Place {
                    route_id,
                    cloid: cloid_of(route_id),
                    asset,
                    is_buy,
                    px,
                    sz,
                    tif,
                    offer_token,
                    want_token,
                    offer_amount: order.offer_amount,
                    want_amount: order.want_amount,
                    escrow,
                },
            );
            self.lz_send(KIND_PLACE, message, return_value, fee, caller, Credit::Order(order_id));
            self.emit(OrderRouted { order_id, route_id, escrow });
            route_id
        }

        fn cancel_route(
            ref self: ContractState, order_id: felt252, return_value: u128, fee: MessagingFee,
        ) {
            let caller = get_caller_address();
            let route_id = self.current_route.read(order_id);
            let mut route = self.routes.read(route_id);
            assert(route.status == ROUTE_OPEN, 'HV_ROUTE_NOT_OPEN');
            assert(!route.cancel_requested, 'HV_CANCEL_REQUESTED');
            if caller != self.keeper.read() {
                // Anyone may pull an expired order back from Hyperliquid, so a
                // silent keeper cannot keep a maker's escrow out forever.
                let order = IVeilPoolDispatcher { contract_address: self.pool.read() }
                    .get_order(order_id);
                assert(get_block_timestamp() > order.expiry, 'HV_NOT_EXPIRED');
            }
            route.cancel_requested = true;
            self.routes.write(route_id, route);
            self
                .lz_send(
                    KIND_CANCEL, encode_cancel(route_id), return_value, fee, caller, Credit::Order(order_id),
                );
            self.emit(CancelRequested { route_id });
        }

        fn release(ref self: ContractState, order_id: felt252) {
            let route_id = self.current_route.read(order_id);
            let mut route = self.routes.read(route_id);
            assert(route.status == ROUTE_CLOSED, 'HV_ROUTE_NOT_CLOSED');
            assert(route.pending_receipts == 0, 'HV_RECEIPTS_PENDING');
            let pool_address = self.pool.read();
            let pool = IVeilPoolDispatcher { contract_address: pool_address };
            // Both sides must agree on what was spent, or the refund would
            // mint twins the omnibus does not hold.
            let on_pool = pool.get_venue_route(order_id);
            assert(on_pool.escrow == route.escrow, 'HV_POOL_ESCROW_MISMATCH');
            assert(on_pool.drawn == route.cum_draw, 'HV_POOL_DRAW_MISMATCH');

            let refund = route.escrow - route.cum_draw;
            route.status = ROUTE_RELEASED;
            self.routes.write(route_id, route);
            if refund != 0 {
                let twin = route.offer_twin;
                IHyperVeilTwinMintDispatcher { contract_address: twin }
                    .mint(get_contract_address(), refund.into());
                self.approve_pool(twin, self.reserved.read(twin) + refund.into());
            }
            pool.venue_release(order_id, refund);
            self.emit(RouteReleased { order_id, route_id, refund });
        }

        fn quote_route(
            self: @ContractState,
            order_id: felt252,
            asset: u32,
            is_buy: bool,
            px: u64,
            sz: u64,
            tif: u8,
            return_value: u128,
        ) -> MessagingFee {
            let order = IVeilPoolDispatcher { contract_address: self.pool.read() }
                .get_order(order_id);
            let round = self.order_round.read(order_id) + 1;
            let route_id = poseidon_hash_span(
                array![DOMAIN_ROUTE, order_id, round.into()].span(),
            );
            let message = encode_place(
                @Place {
                    route_id,
                    cloid: cloid_of(route_id),
                    asset,
                    is_buy,
                    px,
                    sz,
                    tif,
                    offer_token: self.core_token_of(order.offer_token),
                    want_token: self.core_token_of(order.want_token),
                    offer_amount: order.offer_amount,
                    want_amount: order.want_amount,
                    escrow: order.escrow_remaining,
                },
            );
            self.lz_quote(KIND_PLACE, message, return_value)
        }

        fn quote_cancel(self: @ContractState, order_id: felt252, return_value: u128) -> MessagingFee {
            let route_id = self.current_route.read(order_id);
            self.lz_quote(KIND_CANCEL, encode_cancel(route_id), return_value)
        }

        // ── Deposits and exits: fees ────────────────────────────────────────
        fn fund_note(ref self: ContractState, note_id: felt252, amount: u256) {
            assert(amount != 0, 'ZERO_AMOUNT');
            assert(note_id != 0, 'HV_NO_NOTE');
            let native = IERC20Dispatcher { contract_address: self.native_token.read() };
            assert(
                native.transfer_from(get_caller_address(), get_contract_address(), amount),
                'FEE_TRANSFER_FAILED',
            );
            self.note_credit.write(note_id, self.note_credit.read(note_id) + amount);
            self.emit(NoteFunded { note_id, amount });
        }

        fn note_credit(self: @ContractState, note_id: felt252) -> u256 {
            self.note_credit.read(note_id)
        }

        fn quote_exit(self: @ContractState, amount: u128, return_value: u128) -> MessagingFee {
            // The exit id is not known before the call; its bytes do not change
            // the price (same length).
            self.lz_quote(KIND_WITHDRAW, encode_withdraw(0, amount), return_value)
        }

        // ── Views ───────────────────────────────────────────────────────────
        fn deposit_of(self: @ContractState, deposit_id: felt252) -> DepositRecord {
            self.deposits.read(deposit_id)
        }
        fn deposit_of_note(self: @ContractState, note_id: felt252) -> felt252 {
            self.note_deposit.read(note_id)
        }
        fn route_of(self: @ContractState, route_id: felt252) -> RouteRecord {
            self.routes.read(route_id)
        }
        fn current_route(self: @ContractState, order_id: felt252) -> felt252 {
            self.current_route.read(order_id)
        }
        fn receipt_of(self: @ContractState, receipt_id: felt252) -> ReceiptRecord {
            self.receipts.read(receipt_id)
        }
        fn order_credit(self: @ContractState, order_id: felt252) -> u256 {
            self.order_credit.read(order_id)
        }
        fn reserved(self: @ContractState, twin: ContractAddress) -> u256 {
            self.reserved.read(twin)
        }
        fn twin_of(self: @ContractState, core_token: u64) -> ContractAddress {
            self.twins.read(core_token)
        }
        fn core_token_of(self: @ContractState, twin: ContractAddress) -> u64 {
            let plus_one = self.core_token_plus_one.read(twin);
            assert(plus_one != 0, 'HV_UNKNOWN_TWIN');
            plus_one - 1
        }

        // ── Admin ───────────────────────────────────────────────────────────
        fn set_peer(ref self: ContractState, eid: u32, peer: Bytes32) {
            self.assert_owner();
            self.peers.write(eid, peer);
            self.emit(PeerSet { eid, peer });
        }
        fn get_peer(self: @ContractState, eid: u32) -> Bytes32 {
            self.peers.read(eid)
        }
        fn set_delegate(ref self: ContractState, delegate: ContractAddress) {
            self.assert_owner();
            IEndpointV2Dispatcher { contract_address: self.endpoint.read() }.set_delegate(delegate);
        }
        fn set_twin(ref self: ContractState, core_token: u64, twin: ContractAddress) {
            self.assert_owner();
            assert(!twin.is_zero(), 'ZERO_TWIN');
            assert(self.twins.read(core_token).is_zero(), 'HV_TWIN_SET');
            assert(self.core_token_plus_one.read(twin) == 0, 'HV_TWIN_MAPPED');
            self.twins.write(core_token, twin);
            self.core_token_plus_one.write(twin, core_token + 1);
            self.emit(TwinSet { core_token, twin });
        }
        fn set_pool(ref self: ContractState, pool: ContractAddress) {
            self.assert_owner();
            assert(!pool.is_zero(), 'ZERO_POOL');
            self.pool.write(pool);
            self.emit(ConfigSet { what: 'pool', value: pool.into() });
        }
        fn set_keeper(ref self: ContractState, keeper: ContractAddress) {
            self.assert_owner();
            self.keeper.write(keeper);
            self.emit(ConfigSet { what: 'keeper', value: keeper.into() });
        }
        fn set_entry_helper(ref self: ContractState, entry_helper: ContractAddress) {
            self.assert_owner();
            self.entry_helper.write(entry_helper);
            self.emit(ConfigSet { what: 'entry_helper', value: entry_helper.into() });
        }
        fn set_exit_vault(ref self: ContractState, exit_vault: ContractAddress) {
            self.assert_owner();
            self.exit_vault.write(exit_vault);
            self.emit(ConfigSet { what: 'exit_vault', value: exit_vault.into() });
        }
        fn set_gas(ref self: ContractState, kind: u8, gas: u128) {
            self.assert_owner();
            assert(
                kind == KIND_DEPOSIT || kind == KIND_PLACE || kind == KIND_CANCEL
                    || kind == KIND_WITHDRAW,
                'HV_NOT_OUTBOUND_KIND',
            );
            self.gas.write(kind, gas);
            self.emit(ConfigSet { what: kind.into(), value: gas.into() });
        }
        fn get_gas(self: @ContractState, kind: u8) -> u128 {
            self.gas.read(kind)
        }
        fn pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }
        fn keeper(self: @ContractState) -> ContractAddress {
            self.keeper.read()
        }
        fn entry_helper(self: @ContractState) -> ContractAddress {
            self.entry_helper.read()
        }
        fn exit_vault(self: @ContractState) -> ContractAddress {
            self.exit_vault.read()
        }
        fn dst_eid(self: @ContractState) -> u32 {
            self.dst_eid.read()
        }
        fn native_token(self: @ContractState) -> ContractAddress {
            self.native_token.read()
        }
        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }
        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            self.assert_owner();
            assert(!new_owner.is_zero(), 'ZERO_OWNER');
            let previous_owner = self.owner.read();
            self.owner.write(new_owner);
            self.emit(OwnershipTransferred { previous_owner, new_owner });
        }
    }

    // ── The pool's invoke adapter for exits ─────────────────────────────────
    #[abi(embed_v0)]
    impl ExitAdapterImpl of IHyperVeilExitAdapter<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            open_note_id: felt252,
            exit_amount: u128,
            usdc_note_id: felt252,
            return_value: u128,
        ) -> Array<OpenNoteDeposit> {
            let pool = self.pool.read();
            assert(get_caller_address() == pool, 'ONLY_POOL');
            assert(exit_amount != 0, 'ZERO_AMOUNT');
            assert(exit_amount % USDC_CORE_PER_CCTP_UNIT == 0, 'HV_EXIT_NOT_WHOLE_UNITS');
            assert(usdc_note_id != 0, 'HV_NO_NOTE');
            let vault = self.exit_vault.read();
            assert(!vault.is_zero(), 'HV_NO_EXIT_VAULT');
            let twin = self.usdc_twin();
            let this = get_contract_address();

            // The pool paid `exit_amount + 1` just before this call (same
            // transaction, nothing in between): it is what sits here beyond
            // the receipts' custody.
            let reserved = self.reserved.read(twin);
            let token = IERC20Dispatcher { contract_address: twin };
            assert(
                token.balance_of(this) >= reserved + exit_amount.into() + EXIT_CHANGE.into(),
                'HV_EXIT_NOT_PAID',
            );
            IHyperVeilTwinMintDispatcher { contract_address: twin }.burn(this, exit_amount.into());

            let nonce = self.exit_nonce.read() + 1;
            self.exit_nonce.write(nonce);
            let exit_id = poseidon_hash_span(array![DOMAIN_EXIT, this.into(), nonce.into()].span());
            // The vault checks the note (an empty real-USDC open note no other
            // exit names) before anything leaves: a bad note reverts the whole
            // invoke and the user keeps the twin.
            IExitRegistryDispatcher { contract_address: vault }
                .register_exit(exit_id, usdc_note_id, exit_amount / USDC_CORE_PER_CCTP_UNIT);

            // Paid from the note's prepaid credit: the pool cannot pay.
            let message = encode_withdraw(exit_id, exit_amount);
            let fee = self.lz_quote(KIND_WITHDRAW, message.clone(), return_value);
            self
                .lz_send(
                    KIND_WITHDRAW, message, return_value, fee, Zero::zero(), Credit::Note(usdc_note_id),
                );
            self.emit(ExitRequested { exit_id, note_id: usdc_note_id, amount: exit_amount });

            // The change goes back into the user's open note; the pool pulls it.
            self.approve_pool(twin, reserved + EXIT_CHANGE.into());
            array![OpenNoteDeposit { note_id: open_note_id, token: twin, amount: EXIT_CHANGE }]
        }
    }

    // HyperCore's client order id for a route: the route id's low 128 bits (0
    // means "no cloid" to HyperCore, so it is never used).
    fn cloid_of(route_id: felt252) -> u128 {
        let word: u256 = route_id.into();
        if word.low == 0 {
            1
        } else {
            word.low
        }
    }

    fn deposit_id_of(pool: ContractAddress, note_id: felt252) -> felt252 {
        poseidon_hash_span(array![DOMAIN_DEPOSIT, pool.into(), note_id].span())
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn assert_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), 'ONLY_OWNER');
        }

        fn usdc_twin(self: @ContractState) -> ContractAddress {
            let twin = self.twins.read(USDC_CORE_TOKEN);
            assert(!twin.is_zero(), 'HV_NO_USDC_TWIN');
            twin
        }

        // The note must be an empty USDC-twin open note nobody has claimed yet.
        // First deposit wins: a second deposit naming the same note is refused
        // here, before its USDC is burned, so it costs nothing.
        fn check_deposit_note(self: @ContractState, note_id: felt252) -> felt252 {
            assert(note_id != 0, 'HV_NO_NOTE');
            assert(self.note_deposit.read(note_id) == 0, 'HV_NOTE_CLAIMED');
            let pool_address = self.pool.read();
            let pool = IVeilPoolDispatcher { contract_address: pool_address };
            assert(pool.get_open_note(note_id).token == self.usdc_twin(), 'HV_NOT_USDC_NOTE');
            assert(
                *pool.get_notes_batch(array![note_id]).at(0).encrypted_amount == EMPTY_OPEN_NOTE,
                'HV_NOTE_NOT_EMPTY',
            );
            deposit_id_of(pool_address, note_id)
        }

        fn handle_credit(ref self: ContractState, deposit_id: felt252, amount: u128) {
            let mut deposit = self.deposits.read(deposit_id);
            // A credit for a deposit we never sent is a peer bug; a second
            // credit for one already settled is dropped.
            assert(deposit.status != 0, 'HV_UNKNOWN_DEPOSIT');
            if deposit.status != DEPOSIT_SENT {
                return;
            }
            assert(amount != 0, 'HV_ZERO_CREDIT');
            deposit.credited = amount;
            let twin = self.usdc_twin();
            if self.mint_into_pool_note(twin, deposit.note_id, amount, false) {
                deposit.status = DEPOSIT_CREDITED;
                self.deposits.write(deposit_id, deposit);
                self.emit(DepositCredited { deposit_id, amount });
            } else {
                deposit.status = DEPOSIT_QUARANTINED;
                self.deposits.write(deposit_id, deposit);
                self.emit(CreditQuarantined { deposit_id, amount, reason: 'POOL_REFUSED' });
            }
        }

        // Mint into custody, let the pool pull into the note, and hold nothing
        // afterwards. With `must_succeed` false a refusing pool is survived:
        // the mint is burned back and the caller quarantines.
        fn mint_into_pool_note(
            ref self: ContractState,
            twin: ContractAddress,
            note_id: felt252,
            amount: u128,
            must_succeed: bool,
        ) -> bool {
            let this = get_contract_address();
            let pool = self.pool.read();
            let reserved = self.reserved.read(twin);
            IHyperVeilTwinMintDispatcher { contract_address: twin }.mint(this, amount.into());
            self.approve_pool(twin, reserved + amount.into());
            let mut call_data: Array<felt252> = array![];
            note_id.serialize(ref call_data);
            twin.serialize(ref call_data);
            amount.serialize(ref call_data);
            let outcome = call_contract_syscall(pool, selector!("fill_open_note"), call_data.span());
            let token = IERC20Dispatcher { contract_address: twin };
            let taken = token.balance_of(this) == reserved;
            if must_succeed {
                outcome.unwrap_syscall();
                assert(taken, 'HV_POOL_TOOK_NOTHING');
                return true;
            }
            if outcome.is_ok() && taken {
                return true;
            }
            // Burn back whatever is still here beyond the receipts' custody,
            // and never leave an allowance above it.
            let left = token.balance_of(this) - reserved;
            if left != 0 {
                IHyperVeilTwinMintDispatcher { contract_address: twin }.burn(this, left);
            }
            self.approve_pool(twin, reserved);
            false
        }

        fn handle_fill(ref self: ContractState, item: FillItem) {
            let mut route = self.routes.read(item.route_id);
            assert(route.status != ROUTE_NONE, 'HV_UNKNOWN_ROUTE');
            // Stale or duplicate: already reflected in a later cumulative total.
            if item.seq <= route.seq {
                return;
            }
            assert(route.status == ROUTE_OPEN, 'HV_ROUTE_ALREADY_CLOSED');
            assert(item.cum_draw >= route.cum_draw, 'HV_DRAW_REGRESSED');
            assert(item.cum_deliver >= route.cum_deliver, 'HV_DELIVER_REGRESSED');
            assert(item.cum_draw <= route.escrow, 'HV_DRAW_OVER_ESCROW');
            let draw = item.cum_draw - route.cum_draw;
            let deliver = item.cum_deliver - route.cum_deliver;

            if deliver != 0 {
                let receipt_id = poseidon_hash_span(
                    array![DOMAIN_RECEIPT, item.route_id, item.seq.into()].span(),
                );
                self
                    .receipts
                    .write(
                        receipt_id,
                        ReceiptRecord {
                            route_id: item.route_id,
                            order_id: route.order_id,
                            draw,
                            deliver,
                            pending: true,
                        },
                    );
                let twin = route.want_twin;
                IHyperVeilTwinMintDispatcher { contract_address: twin }
                    .mint(get_contract_address(), deliver.into());
                let reserved = self.reserved.read(twin) + deliver.into();
                self.reserved.write(twin, reserved);
                self.approve_pool(twin, reserved);
                route.pending_receipts += 1;
                self.emit(ReceiptCreated { receipt_id, route_id: item.route_id, draw, deliver });
            } else {
                // A draw is only ever reported together with what it bought.
                assert(draw == 0, 'HV_DRAW_WITHOUT_DELIVERY');
            }

            route.cum_draw = item.cum_draw;
            route.cum_deliver = item.cum_deliver;
            route.seq = item.seq;
            if item.closed {
                route.status = ROUTE_CLOSED;
                self
                    .emit(
                        RouteClosed {
                            route_id: item.route_id,
                            cum_draw: item.cum_draw,
                            cum_deliver: item.cum_deliver,
                        },
                    );
            }
            self.routes.write(item.route_id, route);
        }

        fn approve_pool(ref self: ContractState, twin: ContractAddress, amount: u256) {
            IERC20Dispatcher { contract_address: twin }.approve(self.pool.read(), amount);
        }

        fn lz_options(self: @ContractState, kind: u8, return_value: u128) -> ByteArray {
            let gas = self.gas.read(kind);
            assert(gas != 0, 'HV_GAS_UNSET');
            build_lz_receive_options(gas, return_value)
        }

        fn lz_quote(
            self: @ContractState, kind: u8, message: ByteArray, return_value: u128,
        ) -> MessagingFee {
            let dst_eid = self.dst_eid.read();
            IEndpointV2Dispatcher { contract_address: self.endpoint.read() }
                .quote(
                    MessagingParams {
                        dst_eid,
                        receiver: self.peer_or_revert(dst_eid),
                        message,
                        options: self.lz_options(kind, return_value),
                        pay_in_lz_token: false,
                    },
                    get_contract_address(),
                )
        }

        fn peer_or_revert(self: @ContractState, eid: u32) -> Bytes32 {
            let peer = self.peers.read(eid);
            assert(peer.value != 0, 'NO_PEER');
            peer
        }

        // Collect `fee.native_fee` (from the prepaid credit first, the rest
        // from `payer`), approve the endpoint for it, and send. Refunds go to
        // the payer, or stay here as the credit's when there is none.
        fn lz_send(
            ref self: ContractState,
            kind: u8,
            message: ByteArray,
            return_value: u128,
            fee: MessagingFee,
            payer: ContractAddress,
            credit: Credit,
        ) -> MessageReceipt {
            assert(fee.lz_token_fee == 0, 'LZ_TOKEN_FEE_UNSUPPORTED');
            let endpoint = self.endpoint.read();
            let this = get_contract_address();
            let options = self.lz_options(kind, return_value);

            let available = match credit {
                Credit::None => 0,
                Credit::Order(order_id) => self.order_credit.read(order_id),
                Credit::Note(note_id) => self.note_credit.read(note_id),
            };
            let used = if available < fee.native_fee {
                available
            } else {
                fee.native_fee
            };
            match credit {
                Credit::None => {},
                Credit::Order(order_id) => self.order_credit.write(order_id, available - used),
                Credit::Note(note_id) => self.note_credit.write(note_id, available - used),
            }
            let from_payer = fee.native_fee - used;
            let native = IERC20Dispatcher { contract_address: self.native_token.read() };
            if from_payer != 0 {
                assert(!payer.is_zero(), 'HV_FEE_UNFUNDED');
                assert(native.allowance(payer, this) >= from_payer, 'FEE_ALLOWANCE_TOO_LOW');
                assert(native.transfer_from(payer, this, from_payer), 'FEE_TRANSFER_FAILED');
            }
            let refund_to = if payer.is_zero() {
                this
            } else {
                payer
            };
            if fee.native_fee != 0 {
                native.approve(endpoint, fee.native_fee);
            }

            let dst_eid = self.dst_eid.read();
            IEndpointV2Dispatcher { contract_address: endpoint }
                .send(
                    MessagingParams {
                        dst_eid,
                        receiver: self.peer_or_revert(dst_eid),
                        message,
                        options,
                        pay_in_lz_token: false,
                    },
                    refund_to,
                )
        }
    }
}
