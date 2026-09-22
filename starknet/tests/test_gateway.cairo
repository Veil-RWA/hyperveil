// HyperVeil's Starknet side end to end, against the REAL Veil pool.
//
// Deployed for every test: the real `VeilERC3643` pool, the KYC permission
// manager, two twins (USDC = HyperCore token 0, HYPE = token 150), the gateway,
// the entry helper (deposit adapter), the fee adapter, the exit vault, the
// STRK20 -> Veil entry, and the KYC rules that let real USDC and STRK sit in
// the pool as rules tokens, held by users inside it. Mocked, because they live
// elsewhere: the LayerZero endpoint, Circle's CCTP contracts and FiatToken
// (USDC), and StarkWare's STRK20 pool (see src/mocks.cairo for what each
// reproduces).
//
// The omnibus is played by the tests: its messages are delivered through the
// mock endpoint from the configured peer, exactly as LayerZero would.

use core::poseidon::poseidon_hash_span;
use hyperveil::bytes::{append_be, append_u256};
use hyperveil::codec::{
    FillItem, Place, encode_cancel, encode_credit, encode_deposit, encode_fill, encode_place,
    encode_withdraw,
};
use hyperveil::entry_helper::{
    HYPEREVM_DOMAIN, IHyperVeilEntryHelperDispatcher, IHyperVeilEntryHelperDispatcherTrait,
};
use hyperveil::exit_vault::{
    EXIT_DELIVERED, EXIT_FUNDED, EXIT_REGISTERED, IHyperVeilExitVaultDispatcher,
    IHyperVeilExitVaultDispatcherTrait,
};
use hyperveil::fee_adapter::{
    FUND_NOTE, FUND_ORDER, IHyperVeilFeeAdapterDispatcher, IHyperVeilFeeAdapterDispatcherTrait,
};
use hyperveil::gateway::{
    DEPOSIT_CREDITED, DEPOSIT_QUARANTINED, DEPOSIT_SENT, IHyperVeilExitAdapterDispatcherTrait,
    IHyperVeilGatewayDispatcher, IHyperVeilGatewayDispatcherTrait, ROUTE_CLOSED, ROUTE_OPEN,
    ROUTE_RELEASED,
};
use hyperveil::interfaces::{IERC20Dispatcher, IERC20DispatcherTrait};
use hyperveil::lz::{
    Bytes32, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait, MessagingFee,
    build_lz_receive_options,
};
use hyperveil::mocks::{
    IMockERC20Dispatcher, IMockERC20DispatcherTrait, IMockEndpointDispatcher,
    IMockEndpointDispatcherTrait, IMockFiatTokenDispatcher, IMockFiatTokenDispatcherTrait,
    IMockStrk20PoolDispatcher, IMockStrk20PoolDispatcherTrait, IMockTokenMessengerDispatcher,
    IMockTokenMessengerDispatcherTrait,
};
use hyperveil::permission_manager::{
    IHyperVeilPermissionManagerDispatcher, IHyperVeilPermissionManagerDispatcherTrait,
};
use hyperveil::strk20_entry::{IHyperVeilStrk20EntryDispatcher, IHyperVeilStrk20EntryDispatcherTrait};
use hyperveil::twin::{IHyperVeilTwinDispatcher, IHyperVeilTwinDispatcherTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, map_entry_address, spy_messages_to_l1,
    start_cheat_block_timestamp_global, start_cheat_caller_address, stop_cheat_caller_address,
    store,
};
use starknet::ContractAddress;
use veil::interfaces::IVeilERC3643::{
    IVeilERC3643Dispatcher, IVeilERC3643DispatcherTrait, InvokeSwap, MakerOpening,
    SenderBalanceRules, VenueFill,
};
use super::proof::{
    create_open_note, curve_x, decode, deposit, invoke, maker_commitment, neutral_rules_hash,
    note_id, prove_last, register, self_channel_key, venue_fill_derive, virtual_tx,
};
use super::test_codec::hex;

fn owner() -> ContractAddress { 0xA0.try_into().unwrap() }
fn keeper() -> ContractAddress { 0xB0.try_into().unwrap() }
fn maker() -> ContractAddress { 0xC0.try_into().unwrap() }
fn stranger() -> ContractAddress { 0xD0.try_into().unwrap() }
fn relayer() -> ContractAddress { 0xF0.try_into().unwrap() }

const HL_EID: u32 = 30367;
const OMNIBUS: u256 = 0x1111111111111111111111111111111111111111;
/// The keeper's HyperEVM address: where Circle mints a deposit's USDC.
const KEEPER_EVM: u256 = 0x2222222222222222222222222222222222222222;
const HYPE: u64 = 150;
const LZ_FEE: u256 = 1_000;
const GAS: u128 = 250_000;
const TWO_POW_128: felt252 = 0x100000000000000000000000000000000;

// A Veil order: 1_000 USDC for 40 HYPE (limit 25 USDC per HYPE), both 8 dp.
const ORDER: felt252 = 'ORDER_1';
const OFFER: u128 = 100_000_000_000;
const WANT: u128 = 4_000_000_000;
const EXPIRY: u64 = 1_000_000;

#[derive(Drop, Copy)]
struct Env {
    pool: IVeilERC3643Dispatcher,
    gateway: IHyperVeilGatewayDispatcher,
    helper: ContractAddress,
    fee: ContractAddress,
    vault: IHyperVeilExitVaultDispatcher,
    entry: ContractAddress,
    pm: ContractAddress,
    usdc_twin: ContractAddress,
    hype_twin: ContractAddress,
    strk: ContractAddress,
    usdc: ContractAddress,
    endpoint: IMockEndpointDispatcher,
    messenger: IMockTokenMessengerDispatcher,
    strk20: IMockStrk20PoolDispatcher,
}

fn deploy(name: ByteArray, calldata: Array<felt252>) -> ContractAddress {
    let class = declare(name).unwrap().contract_class();
    let (address, _) = class.deploy(@calldata).unwrap();
    address
}

fn deploy_twin(
    symbol: ByteArray, hl_token: u64, pm: ContractAddress, gateway: ContractAddress,
) -> ContractAddress {
    let mut cd: Array<felt252> = array![];
    let name: ByteArray = "HyperVeil twin";
    name.serialize(ref cd);
    symbol.serialize(ref cd);
    8_u8.serialize(ref cd);
    hl_token.serialize(ref cd);
    owner().serialize(ref cd);
    pm.serialize(ref cd);
    gateway.serialize(ref cd);
    deploy("HyperVeilTwin", cd)
}

fn setup() -> Env {
    virtual_tx();
    start_cheat_block_timestamp_global(100);
    let strk = deploy("MockERC20", array![]);
    let usdc = deploy("MockFiatToken", array![]);
    let endpoint = deploy("MockEndpoint", array![strk.into()]);
    let pm = deploy("HyperVeilPermissionManager", array![owner().into(), owner().into()]);
    let pool = deploy(
        "VeilERC3643", array![owner().into(), owner().into(), curve_x(77), keeper().into()],
    );
    let gateway = deploy(
        "HyperVeilGateway",
        array![owner().into(), endpoint.into(), strk.into(), HL_EID.into(), pool.into()],
    );
    let usdc_twin = deploy_twin("hvUSDC", 0, pm, gateway);
    let hype_twin = deploy_twin("hvHYPE", HYPE, pm, gateway);
    let messenger = deploy("MockTokenMessenger", array![]);
    let transmitter = deploy("MockMessageTransmitter", array![usdc.into()]);
    let strk20 = deploy("MockStrk20Pool", array![]);
    let helper = deploy(
        "HyperVeilEntryHelper",
        array![
            gateway.into(), usdc.into(), messenger.into(), OMNIBUS.low.into(), OMNIBUS.high.into(),
            KEEPER_EVM.low.into(), KEEPER_EVM.high.into(),
        ],
    );
    let fee = deploy("HyperVeilFeeAdapter", array![gateway.into()]);
    let vault = deploy(
        "HyperVeilExitVault",
        array![gateway.into(), usdc.into(), transmitter.into(), OMNIBUS.low.into(), OMNIBUS.high.into()],
    );
    let entry = deploy("HyperVeilStrk20Entry", array![strk20.into(), pool.into()]);
    let usdc_rules = deploy("HyperVeilKycRules", array![usdc.into(), pm.into(), 1]);
    let strk_rules = deploy("HyperVeilKycRules", array![strk.into(), pm.into(), 0]);

    // The pool carries the twins AND real USDC and STRK, all KYC-gated by the
    // HyperVeil permission manager: the twins as allowlisted tokens, USDC and
    // STRK as rules tokens (they have no KYC hook of their own). The invoke
    // adapters (gateway, entry helper, fee adapter) hold a token for an
    // instant, so they are whitelisted; the vault and the STRK20 entry only
    // fill open notes, which needs no whitelisting, only the adapter allowance.
    let p = IVeilERC3643Dispatcher { contract_address: pool };
    start_cheat_caller_address(pool, owner());
    p.add_allowlisted_token(usdc_twin, pm, 0);
    p.add_allowlisted_token(hype_twin, pm, 0);
    p.add_rules_token(usdc, usdc_rules);
    p.add_rules_token(strk, strk_rules);
    p.set_venue(gateway);
    p.set_adapter_allowed(gateway, true);
    p.set_adapter_allowed(helper, true);
    p.set_adapter_allowed(fee, true);
    p.set_adapter_allowed(vault, true);
    p.set_adapter_allowed(entry, true);
    stop_cheat_caller_address(pool);

    start_cheat_caller_address(pm, owner());
    IHyperVeilPermissionManagerDispatcher { contract_address: pm }
        .whitelist(array![pool, gateway, helper, fee, maker()]);
    stop_cheat_caller_address(pm);

    let g = IHyperVeilGatewayDispatcher { contract_address: gateway };
    start_cheat_caller_address(gateway, owner());
    g.set_twin(0, usdc_twin);
    g.set_twin(HYPE, hype_twin);
    g.set_peer(HL_EID, Bytes32 { value: OMNIBUS });
    g.set_keeper(keeper());
    g.set_gas(1, GAS);
    g.set_gas(2, GAS);
    g.set_gas(3, GAS);
    g.set_gas(4, GAS);
    g.set_entry_helper(helper);
    g.set_exit_vault(vault);
    stop_cheat_caller_address(gateway);

    let e = IMockEndpointDispatcher { contract_address: endpoint };
    e.set_fee(LZ_FEE);
    Env {
        pool: p,
        gateway: g,
        helper,
        fee,
        vault: IHyperVeilExitVaultDispatcher { contract_address: vault },
        entry,
        pm,
        usdc_twin,
        hype_twin,
        strk,
        usdc,
        endpoint: e,
        messenger: IMockTokenMessengerDispatcher { contract_address: messenger },
        strk20: IMockStrk20PoolDispatcher { contract_address: strk20 },
    }
}

fn mint(token: ContractAddress, to: ContractAddress, amount: u256) {
    IMockERC20Dispatcher { contract_address: token }.mint(to, amount);
}

fn balance(token: ContractAddress, holder: ContractAddress) -> u256 {
    IERC20Dispatcher { contract_address: token }.balance_of(holder)
}

// The gateway minting a twin, as only it can.
fn gateway_mint(env: Env, twin: ContractAddress, to: ContractAddress, amount: u128) {
    start_cheat_caller_address(twin, env.gateway.contract_address);
    IHyperVeilTwinDispatcher { contract_address: twin }.mint(to, amount.into());
    stop_cheat_caller_address(twin);
}

fn from_omnibus(env: Env, message: ByteArray) {
    env.endpoint.deliver(env.gateway.contract_address, HL_EID, Bytes32 { value: OMNIBUS }, message);
}

// An empty open note for `token` in the pool, as `create_open_note` leaves it.
fn seed_open_note(env: Env, note_id: felt252, token: ContractAddress) {
    let pool = env.pool.contract_address;
    store(pool, map_entry_address(selector!("notes"), array![note_id].span()), array![TWO_POW_128].span());
    store(
        pool, map_entry_address(selector!("open_notes"), array![note_id].span()), array![token.into()].span(),
    );
}

fn note_value(env: Env, note_id: felt252) -> felt252 {
    *env.pool.get_notes_batch(array![note_id]).at(0).encrypted_amount
}

fn deposit_id_of(env: Env, note_id: felt252) -> felt252 {
    poseidon_hash_span(array!['HV_DEPOSIT', env.pool.contract_address.into(), note_id].span())
}

// ── The user inside the pool ─────────────────────────────────────────────────
//
// A KYC'd user (the maker) registered with the pool, holding real USDC and
// STRK as private notes: USER_USDC6 and USER_STRK, deposited the plain way.

const USER_KEY: felt252 = 0x51F3;
const USER_USDC6: u128 = 1_000_000_000; // 1_000 USDC
const USER_STRK: u128 = 1_000_000;

fn funded_user(env: Env) {
    register(env.pool, maker(), USER_KEY);
    mint(env.usdc, maker(), USER_USDC6.into());
    mint(env.strk, maker(), USER_STRK.into());
    start_cheat_caller_address(env.usdc, maker());
    IERC20Dispatcher { contract_address: env.usdc }.approve(env.pool.contract_address, USER_USDC6.into());
    stop_cheat_caller_address(env.usdc);
    start_cheat_caller_address(env.strk, maker());
    IERC20Dispatcher { contract_address: env.strk }.approve(env.pool.contract_address, USER_STRK.into());
    stop_cheat_caller_address(env.strk);
    deposit(env.pool, maker(), USER_KEY, env.usdc, USER_USDC6, 2);
    deposit(env.pool, maker(), USER_KEY, env.strk, USER_STRK, 3);
}

// The first empty slot of `token` in the user's self-channel.
fn free_slot(env: Env, token: ContractAddress) -> u32 {
    let key = self_channel_key(maker(), USER_KEY);
    let mut i: u32 = 0;
    while note_value(env, note_id(key, token, i)) != 0 {
        i += 1;
    }
    i
}

// A proven same-token invoke: spends `in_amount` of `token`, pays `target`,
// which gets the invoke's open note id first and `tail` after it. With change
// left over, the change note takes the first free slot and the open note the
// next one (the pool's rule for in token == out token).
fn invoke_same(
    env: Env, token: ContractAddress, in_amount: u128, target: ContractAddress, tail: Array<felt252>,
) -> InvokeSwap {
    let open_note = note_id(self_channel_key(maker(), USER_KEY), token, free_slot(env, token) + 1);
    let mut calldata = array![open_note];
    for x in tail {
        calldata.append(x);
    }
    let msg = invoke(env.pool, maker(), USER_KEY, token, in_amount, token, target, calldata);
    assert(msg.open_note_id == open_note, 'open note slot');
    assert(msg.has_change, 'expected change');
    msg
}

// STRK from the pool prepays a fee through the fee adapter.
fn pay_fee(env: Env, target: u8, key: felt252, amount: u128) -> InvokeSwap {
    invoke_same(env, env.strk, amount + 1, env.fee, array![target.into(), key, amount.into()])
}

// ── Fees ─────────────────────────────────────────────────────────────────────

#[test]
fn strk_in_the_pool_prepays_an_order_through_the_fee_adapter() {
    let env = setup();
    funded_user(env);
    let msg = pay_fee(env, FUND_ORDER, ORDER, 5_000);
    assert(env.gateway.order_credit(ORDER) == 5_000, 'order credit');
    assert(balance(env.strk, env.gateway.contract_address) == 5_000, 'gateway strk');
    // 1 unit came back into the user's open note; nothing stays on the adapter.
    assert(note_value(env, msg.open_note_id) == TWO_POW_128 + 1, 'change not returned');
    assert(balance(env.strk, env.fee) == 0, 'adapter kept strk');
    assert(
        balance(env.strk, env.pool.contract_address) == (USER_STRK - 5_000).into(), 'pool strk',
    );
}

#[test]
fn strk_in_the_pool_prepays_a_note() {
    let env = setup();
    funded_user(env);
    pay_fee(env, FUND_NOTE, 'SOME_NOTE', 3_000);
    assert(env.gateway.note_credit('SOME_NOTE') == 3_000, 'note credit');
    assert(env.gateway.order_credit('SOME_NOTE') == 0, 'credit leaked');
}

#[test]
#[should_panic(expected: 'HV_BAD_FEE_TARGET')]
fn the_fee_adapter_only_funds_orders_and_notes() {
    let env = setup();
    mint(env.strk, env.fee, 101);
    start_cheat_caller_address(env.fee, env.pool.contract_address);
    IHyperVeilFeeAdapterDispatcher { contract_address: env.fee }.privacy_invoke(1, 7, ORDER, 100);
}

#[test]
#[should_panic(expected: 'ONLY_POOL')]
fn only_the_pool_invokes_the_fee_adapter() {
    let env = setup();
    IHyperVeilFeeAdapterDispatcher { contract_address: env.fee }.privacy_invoke(1, 0, ORDER, 100);
}

// ── Deposits ─────────────────────────────────────────────────────────────────

const AMOUNT6: u128 = 250_000_000; // 250 USDC
const RETURN_VALUE: u128 = 7_000;

// The user's USDC-twin note, prepaid for its DEPOSIT.
fn twin_note_ready(env: Env) -> felt252 {
    let twin_note = create_open_note(env.pool, maker(), USER_KEY, env.usdc_twin);
    pay_fee(env, FUND_NOTE, twin_note, LZ_FEE.low);
    twin_note
}

// One proven invoke: USDC from the pool to Hyperliquid, credited into
// `twin_note` later.
fn to_hyperliquid(env: Env, twin_note: felt252, amount6: u128) -> InvokeSwap {
    invoke_same(
        env, env.usdc, amount6 + 1, env.helper,
        array![amount6.into(), twin_note, 0, 0, 2000, RETURN_VALUE.into()],
    )
}

#[test]
fn a_deposit_is_one_proven_invoke_that_burns_usdc_through_cctp_and_tells_the_omnibus() {
    let env = setup();
    funded_user(env);
    let twin_note = twin_note_ready(env);
    let msg = to_hyperliquid(env, twin_note, AMOUNT6);
    let deposit_id = deposit_id_of(env, twin_note);

    // The value: burned through CCTP, minted to the keeper, only the omnibus
    // may relay.
    let burn = env.messenger.last_burn();
    assert(burn.caller == env.helper, 'burn caller');
    assert(burn.amount == AMOUNT6.into(), 'burn amount');
    assert(burn.destination_domain == HYPEREVM_DOMAIN, 'burn domain');
    assert(burn.mint_recipient == KEEPER_EVM, 'mint recipient');
    assert(burn.destination_caller == OMNIBUS, 'destination caller');
    assert(burn.burn_token == env.usdc, 'burn token');
    let mut expected_hook: ByteArray = Default::default();
    append_u256(ref expected_hook, deposit_id.into());
    assert(env.messenger.last_hook_data() == expected_hook, 'hook = deposit id');

    // The instruction: DEPOSIT to the omnibus, carrying HYPE for its reply,
    // paid from the note's prepaid credit.
    assert(env.endpoint.last_dst_eid() == HL_EID, 'dst eid');
    assert(env.endpoint.last_message() == encode_deposit(deposit_id, AMOUNT6), 'deposit message');
    assert(env.endpoint.last_options() == build_lz_receive_options(GAS, RETURN_VALUE), 'options');
    assert(env.gateway.note_credit(twin_note) == 0, 'fee not taken from credit');
    let record = env.gateway.deposit_of(deposit_id);
    assert(record.status == DEPOSIT_SENT && record.note_id == twin_note, 'deposit record');
    assert(env.gateway.deposit_of_note(twin_note) == deposit_id, 'note claimed');

    // 1 unit came back; nothing stays on the helper; the pool paid the rest.
    assert(note_value(env, msg.open_note_id) == TWO_POW_128 + 1, 'change not returned');
    assert(balance(env.usdc, env.helper) == 0, 'helper kept usdc');
    assert(
        balance(env.usdc, env.pool.contract_address) == (USER_USDC6 - AMOUNT6).into(), 'pool usdc',
    );
}

#[test]
#[should_panic(expected: 'HV_FEE_UNFUNDED')]
fn a_deposit_whose_note_prepaid_nothing_does_not_happen() {
    let env = setup();
    funded_user(env);
    let twin_note = create_open_note(env.pool, maker(), USER_KEY, env.usdc_twin);
    to_hyperliquid(env, twin_note, AMOUNT6);
}

#[test]
#[should_panic(expected: 'HV_FEE_UNFUNDED')]
fn a_note_credit_pays_only_for_its_own_note() {
    let env = setup();
    funded_user(env);
    pay_fee(env, FUND_NOTE, 'OTHER_NOTE', LZ_FEE.low);
    let twin_note = create_open_note(env.pool, maker(), USER_KEY, env.usdc_twin);
    to_hyperliquid(env, twin_note, AMOUNT6);
}

#[test]
#[should_panic(expected: 'HV_NOTE_CLAIMED')]
fn a_second_deposit_into_the_same_note_is_refused_before_any_burn() {
    let env = setup();
    funded_user(env);
    let twin_note = twin_note_ready(env);
    to_hyperliquid(env, twin_note, AMOUNT6);
    to_hyperliquid(env, twin_note, AMOUNT6);
}

#[test]
#[should_panic(expected: 'HV_NOT_USDC_NOTE')]
fn a_deposit_must_name_a_usdc_twin_note() {
    let env = setup();
    funded_user(env);
    seed_open_note(env, 'HYPE_NOTE', env.hype_twin);
    to_hyperliquid(env, 'HYPE_NOTE', AMOUNT6);
}

#[test]
#[should_panic(expected: 'HV_NOTE_NOT_EMPTY')]
fn a_deposit_must_name_an_empty_note() {
    let env = setup();
    funded_user(env);
    seed_open_note(env, 'TWIN_NOTE', env.usdc_twin);
    store(
        env.pool.contract_address,
        map_entry_address(selector!("notes"), array!['TWIN_NOTE'].span()),
        array![TWO_POW_128 + 5].span(),
    );
    to_hyperliquid(env, 'TWIN_NOTE', AMOUNT6);
}

#[test]
#[should_panic(expected: 'ONLY_ENTRY_HELPER')]
fn only_the_entry_helper_registers_deposits() {
    let env = setup();
    seed_open_note(env, 'TWIN_NOTE', env.usdc_twin);
    start_cheat_caller_address(env.gateway.contract_address, stranger());
    env.gateway.register_deposit('TWIN_NOTE', AMOUNT6, 0);
}

#[test]
#[should_panic(expected: 'ONLY_POOL')]
fn only_the_pool_invokes_the_entry_helper() {
    let env = setup();
    IHyperVeilEntryHelperDispatcher { contract_address: env.helper }
        .privacy_invoke(1, AMOUNT6, 'TWIN_NOTE', 0, 2000, 0);
}

// A deposit sent, its twin note waiting for CREDIT.
fn deposited(env: Env) -> (felt252, felt252) {
    funded_user(env);
    let twin_note = twin_note_ready(env);
    to_hyperliquid(env, twin_note, AMOUNT6);
    (twin_note, deposit_id_of(env, twin_note))
}

#[test]
fn credit_mints_the_usdc_twin_straight_into_the_note() {
    let env = setup();
    let (twin_note, deposit_id) = deposited(env);
    // 250 USDC minus a 0.1 USDC CCTP fee, in HyperCore's 8 decimals.
    let credited: u128 = 24_990_000_000;
    from_omnibus(env, encode_credit(deposit_id, credited));

    assert(note_value(env, twin_note) == TWO_POW_128 + credited.into(), 'note not credited');
    assert(balance(env.usdc_twin, env.pool.contract_address) == credited.into(), 'pool balance');
    assert(balance(env.usdc_twin, env.gateway.contract_address) == 0, 'gateway kept twin');
    let record = env.gateway.deposit_of(deposit_id);
    assert(record.status == DEPOSIT_CREDITED && record.credited == credited, 'record');
}

#[test]
fn a_credit_the_pool_refuses_is_quarantined_and_retried() {
    let env = setup();
    let (twin_note, deposit_id) = deposited(env);
    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.pause();
    stop_cheat_caller_address(env.pool.contract_address);

    from_omnibus(env, encode_credit(deposit_id, 24_990_000_000));
    assert(env.gateway.deposit_of(deposit_id).status == DEPOSIT_QUARANTINED, 'not quarantined');
    // Nothing exists as a public balance while quarantined.
    assert(balance(env.usdc_twin, env.gateway.contract_address) == 0, 'twin left in gateway');

    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.unpause();
    stop_cheat_caller_address(env.pool.contract_address);
    env.gateway.retry_credit(deposit_id);
    assert(note_value(env, twin_note) == TWO_POW_128 + 24_990_000_000, 'retry not credited');
    assert(env.gateway.deposit_of(deposit_id).status == DEPOSIT_CREDITED, 'status');
}

#[test]
fn a_repeated_credit_is_dropped() {
    let env = setup();
    let (twin_note, deposit_id) = deposited(env);
    from_omnibus(env, encode_credit(deposit_id, 100));
    from_omnibus(env, encode_credit(deposit_id, 100));
    assert(note_value(env, twin_note) == TWO_POW_128 + 100, 'credited twice');
}

#[test]
#[should_panic(expected: 'HV_UNKNOWN_DEPOSIT')]
fn a_credit_for_an_unknown_deposit_is_a_protocol_error() {
    let env = setup();
    from_omnibus(env, encode_credit('NOPE', 100));
}

#[test]
#[should_panic(expected: 'ONLY_PEER')]
fn only_the_omnibus_speaks_for_hyperliquid() {
    let env = setup();
    env
        .endpoint
        .deliver(
            env.gateway.contract_address,
            HL_EID,
            Bytes32 { value: 0x2222 },
            encode_credit('ANY', 100),
        );
}

#[test]
#[should_panic(expected: 'ONLY_ENDPOINT')]
fn only_the_endpoint_delivers() {
    let env = setup();
    ILayerZeroReceiverDispatcher { contract_address: env.gateway.contract_address }
        .lz_receive(
            hyperveil::lz::Origin { src_eid: HL_EID, sender: Bytes32 { value: OMNIBUS }, nonce: 1 },
            Bytes32 { value: 1 },
            encode_credit(1, 1),
            stranger(),
            Default::default(),
            0,
        );
}

// ── USDC and STRK in the pool: KYC rules ────────────────────────────────────

#[test]
#[should_panic(expected: 'NOT_APPROVED')]
fn an_account_off_the_kyc_list_cannot_hold_usdc_in_the_pool() {
    let env = setup();
    register(env.pool, stranger(), USER_KEY);
    create_open_note(env.pool, stranger(), USER_KEY, env.usdc);
}

#[test]
#[should_panic(expected: 'TOKEN_PAUSED')]
fn circles_pause_stops_usdc_in_the_pool() {
    let env = setup();
    register(env.pool, maker(), USER_KEY);
    IMockFiatTokenDispatcher { contract_address: env.usdc }.set_paused(true);
    create_open_note(env.pool, maker(), USER_KEY, env.usdc);
}

#[test]
#[should_panic(expected: 'FROZEN_BY_ISSUER')]
fn circles_blocklist_freezes_an_account_in_the_pool() {
    let env = setup();
    register(env.pool, maker(), USER_KEY);
    IMockFiatTokenDispatcher { contract_address: env.usdc }.set_blocklisted(maker(), true);
    create_open_note(env.pool, maker(), USER_KEY, env.usdc);
}

#[test]
fn strk_follows_only_the_kyc_list() {
    let env = setup();
    register(env.pool, maker(), USER_KEY);
    // STRK has no pause or blocklist; the whitelisted user may hold it.
    create_open_note(env.pool, maker(), USER_KEY, env.strk);
}

// ── STRK20 -> Veil ───────────────────────────────────────────────────────────
//
// A user's private STRK20 balance moves into their Veil balance in one STRK20
// transaction: Withdraw to the entry, Invoke the entry, which fills the user's
// Veil open note.

const FROM_STRK20: u128 = 40_000_000; // 40 USDC

fn strk20_to_veil(env: Env, token: ContractAddress, note: felt252, amount: u128) {
    mint(token, env.strk20.contract_address, amount.into());
    env
        .strk20
        .invoke(
            env.entry, array![(token, amount.into())], array![],
            array![token.into(), note, amount.into()],
        );
}

#[test]
fn strk20_usdc_lands_in_a_veil_open_note() {
    let env = setup();
    register(env.pool, maker(), USER_KEY);
    let note = create_open_note(env.pool, maker(), USER_KEY, env.usdc);
    strk20_to_veil(env, env.usdc, note, FROM_STRK20);
    assert(note_value(env, note) == TWO_POW_128 + FROM_STRK20.into(), 'note not filled');
    assert(balance(env.usdc, env.pool.contract_address) == FROM_STRK20.into(), 'pool usdc');
    assert(balance(env.usdc, env.entry) == 0, 'entry kept usdc');
}

#[test]
fn strk20_strk_lands_in_a_veil_open_note() {
    let env = setup();
    register(env.pool, maker(), USER_KEY);
    let note = create_open_note(env.pool, maker(), USER_KEY, env.strk);
    strk20_to_veil(env, env.strk, note, 9_000);
    assert(note_value(env, note) == TWO_POW_128 + 9_000, 'note not filled');
}

#[test]
#[should_panic(expected: 'NOT_OPEN_NOTE')]
fn strk20_entry_only_fills_real_open_notes() {
    let env = setup();
    strk20_to_veil(env, env.usdc, 'NO_SUCH_NOTE', FROM_STRK20);
}

#[test]
#[should_panic(expected: 'TOKEN_MISMATCH')]
fn strk20_entry_fills_only_a_note_of_the_same_token() {
    let env = setup();
    register(env.pool, maker(), USER_KEY);
    let note = create_open_note(env.pool, maker(), USER_KEY, env.strk);
    strk20_to_veil(env, env.usdc, note, FROM_STRK20);
}

#[test]
#[should_panic(expected: 'ONLY_STRK20_POOL')]
fn only_the_strk20_pool_invokes_the_entry() {
    let env = setup();
    IHyperVeilStrk20EntryDispatcher { contract_address: env.entry }
        .privacy_invoke(env.usdc, 'NOTE', FROM_STRK20);
}

// ── Routing and fills ────────────────────────────────────────────────────────

fn salt() -> felt252 {
    poseidon_hash_span(array!['SALT', maker().into()].span())
}

fn recv_id() -> felt252 {
    poseidon_hash_span(array!['RCV', ORDER].span())
}

// An OPEN order as `post_order` leaves it: USDC escrow in the pool, an empty
// HYPE receive note locked to the order.
fn seed_order(env: Env) {
    let pool = env.pool.contract_address;
    store(
        pool,
        map_entry_address(selector!("orders"), array![ORDER].span()),
        array![
            maker_commitment(maker(), salt()), 7, 8, 9, env.usdc_twin.into(), env.hype_twin.into(),
            OFFER.into(), WANT.into(), OFFER.into(), 0, recv_id(), EXPIRY.into(), 0,
            neutral_rules_hash(),
        ]
            .span(),
    );
    seed_open_note(env, recv_id(), env.hype_twin);
    store(pool, map_entry_address(selector!("locked_note"), array![recv_id()].span()), array![ORDER].span());
    gateway_mint(env, env.usdc_twin, pool, OFFER);
}

fn fund_and_approve(env: Env, who: ContractAddress, amount: u256) {
    mint(env.strk, who, amount);
    start_cheat_caller_address(env.strk, who);
    IERC20Dispatcher { contract_address: env.strk }.approve(env.gateway.contract_address, amount);
    stop_cheat_caller_address(env.strk);
}

fn fee() -> MessagingFee {
    MessagingFee { native_fee: LZ_FEE, lz_token_fee: 0 }
}

// px 24.9 USDC per HYPE, sz 40 HYPE, GTC — CoreWriter's 1e8 fixed point.
const PX: u64 = 2_490_000_000;
const SZ: u64 = 4_000_000_000;

fn route(env: Env) -> felt252 {
    fund_and_approve(env, relayer(), LZ_FEE);
    start_cheat_caller_address(env.gateway.contract_address, relayer());
    env.gateway.fund_order(ORDER, LZ_FEE);
    stop_cheat_caller_address(env.gateway.contract_address);
    start_cheat_caller_address(env.gateway.contract_address, keeper());
    let route_id = env.gateway.route_order(ORDER, 10107, true, PX, SZ, 2, 9_000, fee());
    stop_cheat_caller_address(env.gateway.contract_address);
    route_id
}

fn routed(env: Env) -> felt252 {
    seed_order(env);
    route(env)
}

fn opening() -> MakerOpening {
    MakerOpening {
        maker: maker(),
        maker_salt: salt(),
        maker_rules: SenderBalanceRules {
            full_required: false, capped: false, locked: 0, min_residual: 0, residual_strict: false,
        },
    }
}

fn receipt_id(route_id: felt252, seq: u64) -> felt252 {
    poseidon_hash_span(array!['HV_RECEIPT', route_id, seq.into()].span())
}

fn fill(route_id: felt252, seq: u64, draw: u128, deliver: u128, closed: bool) -> ByteArray {
    encode_fill(array![FillItem { route_id, seq, cum_draw: draw, cum_deliver: deliver, closed }].span())
}

// The exchange applies receipts through the pool's proven venue fill.
fn apply(env: Env, receipts: Array<felt252>) {
    let mut makers = array![];
    for _ in 0..receipts.len() {
        makers.append(opening());
    }
    let mut spy = spy_messages_to_l1();
    venue_fill_derive(env.pool, keeper(), receipts, makers);
    let mut payload = prove_last(ref spy);
    let msg: VenueFill = decode(ref payload);
    env.pool.venue_fill_settle(msg);
}

#[test]
fn routing_burns_the_escrow_and_places_the_order_on_hypercore() {
    let env = setup();
    let route_id = routed(env);

    assert(env.pool.get_order(ORDER).escrow_remaining == 0, 'escrow left in pool');
    let usdc_supply = balance(env.usdc_twin, env.pool.contract_address)
        + balance(env.usdc_twin, env.gateway.contract_address);
    assert(usdc_supply == 0, 'escrow not burned');
    assert(env.gateway.current_route(ORDER) == route_id, 'current route');
    let r = env.gateway.route_of(route_id);
    assert(r.status == ROUTE_OPEN && r.escrow == OFFER && r.order_id == ORDER, 'route record');

    let route_word: u256 = route_id.into();
    let expected = encode_place(
        @Place {
            route_id,
            cloid: route_word.low,
            asset: 10107,
            is_buy: true,
            px: PX,
            sz: SZ,
            tif: 2,
            offer_token: 0,
            want_token: HYPE,
            offer_amount: OFFER,
            want_amount: WANT,
            escrow: OFFER,
        },
    );
    assert(hex(@env.endpoint.last_message()) == hex(@expected), 'place message');
    assert(env.endpoint.last_options() == build_lz_receive_options(GAS, 9_000), 'options');
    // The fee came from the order's prepaid credit.
    assert(env.gateway.order_credit(ORDER) == 0, 'credit not used');
}

#[test]
fn quotes_price_the_messages_the_keeper_and_users_send() {
    let env = setup();
    seed_order(env);
    let quote = env.gateway.quote_route(ORDER, 10107, true, PX, SZ, 2, 9_000);
    assert(quote.native_fee == LZ_FEE, 'route quote');
    assert(env.gateway.quote_exit(EXIT_AMOUNT, 0).native_fee == LZ_FEE, 'exit quote');
    routed(env);
    assert(env.gateway.quote_cancel(ORDER, 0).native_fee == LZ_FEE, 'cancel quote');
}

#[test]
#[should_panic(expected: 'ONLY_KEEPER')]
fn only_the_keeper_routes() {
    let env = setup();
    seed_order(env);
    start_cheat_caller_address(env.gateway.contract_address, stranger());
    env.gateway.route_order(ORDER, 10107, true, PX, SZ, 2, 0, fee());
}

#[test]
#[should_panic(expected: 'FEE_ALLOWANCE_TOO_LOW')]
fn an_unfunded_route_is_paid_by_the_caller_or_refused() {
    let env = setup();
    seed_order(env);
    start_cheat_caller_address(env.gateway.contract_address, keeper());
    env.gateway.route_order(ORDER, 10107, true, PX, SZ, 2, 0, fee());
}

#[test]
fn a_fill_becomes_a_receipt_the_exchange_applies_to_the_maker() {
    let env = setup();
    let route_id = routed(env);
    // 10 HYPE for 249 USDC (8 dp).
    from_omnibus(env, fill(route_id, 1, 24_900_000_000, 1_000_000_000, false));

    let rid = receipt_id(route_id, 1);
    let receipt = env.gateway.receipt_of(rid);
    assert(receipt.pending && receipt.deliver == 1_000_000_000, 'receipt');
    assert(env.gateway.reserved(env.hype_twin) == 1_000_000_000, 'reserved');
    assert(balance(env.hype_twin, env.gateway.contract_address) == 1_000_000_000, 'custody');

    apply(env, array![rid]);
    assert(note_value(env, recv_id()) == TWO_POW_128 + 1_000_000_000, 'maker not credited');
    assert(env.pool.get_order(ORDER).received == 1_000_000_000, 'received');
    assert(env.pool.get_venue_route(ORDER).drawn == 24_900_000_000, 'pool drawn');
    assert(!env.gateway.receipt_of(rid).pending, 'receipt still pending');
    assert(env.gateway.reserved(env.hype_twin) == 0, 'still reserved');
    assert(balance(env.hype_twin, env.gateway.contract_address) == 0, 'custody left');
}

#[test]
fn stale_and_duplicate_fills_are_dropped() {
    let env = setup();
    let route_id = routed(env);
    from_omnibus(env, fill(route_id, 2, 24_900_000_000, 1_000_000_000, false));
    // A late seq-1 report and a repeat of seq 2: both already reflected.
    from_omnibus(env, fill(route_id, 1, 10_000_000_000, 400_000_000, false));
    from_omnibus(env, fill(route_id, 2, 24_900_000_000, 1_000_000_000, false));
    assert(env.gateway.reserved(env.hype_twin) == 1_000_000_000, 'double counted');
    assert(env.gateway.route_of(route_id).seq == 2, 'seq');
}

#[test]
#[should_panic(expected: 'HV_DELIVER_REGRESSED')]
fn a_report_that_goes_backwards_is_a_protocol_error() {
    let env = setup();
    let route_id = routed(env);
    from_omnibus(env, fill(route_id, 1, 24_900_000_000, 1_000_000_000, false));
    from_omnibus(env, fill(route_id, 2, 24_900_000_000, 900_000_000, false));
}

#[test]
#[should_panic(expected: 'HV_DRAW_OVER_ESCROW')]
fn a_report_cannot_draw_beyond_the_escrow() {
    let env = setup();
    let route_id = routed(env);
    from_omnibus(env, fill(route_id, 1, OFFER + 1, WANT, false));
}

#[test]
#[should_panic(expected: 'HV_DRAW_WITHOUT_DELIVERY')]
fn a_draw_is_reported_with_what_it_bought() {
    let env = setup();
    let route_id = routed(env);
    from_omnibus(env, fill(route_id, 1, 100, 0, false));
}

#[test]
#[should_panic(expected: 'HV_UNKNOWN_ROUTE')]
fn a_fill_for_a_route_never_sent_is_a_protocol_error() {
    let env = setup();
    from_omnibus(env, fill('NOPE', 1, 0, 1, false));
}

#[test]
fn a_closed_route_releases_the_unspent_escrow_to_the_order() {
    let env = setup();
    let route_id = routed(env);
    from_omnibus(env, fill(route_id, 1, 24_900_000_000, 1_000_000_000, true));
    assert(env.gateway.route_of(route_id).status == ROUTE_CLOSED, 'not closed');
    apply(env, array![receipt_id(route_id, 1)]);

    env.gateway.release(ORDER);
    let refund = OFFER - 24_900_000_000;
    assert(env.pool.get_order(ORDER).escrow_remaining == refund, 'escrow not refunded');
    assert(!env.pool.get_venue_route(ORDER).routed, 'still routed');
    assert(balance(env.usdc_twin, env.pool.contract_address) == refund.into(), 'pool usdc');
    assert(env.gateway.route_of(route_id).status == ROUTE_RELEASED, 'not released');
}

#[test]
#[should_panic(expected: 'HV_RECEIPTS_PENDING')]
fn release_waits_for_every_receipt() {
    let env = setup();
    let route_id = routed(env);
    from_omnibus(env, fill(route_id, 1, 24_900_000_000, 1_000_000_000, true));
    env.gateway.release(ORDER);
}

#[test]
#[should_panic(expected: 'HV_ROUTE_NOT_CLOSED')]
fn an_open_route_is_not_released() {
    let env = setup();
    routed(env);
    env.gateway.release(ORDER);
}

#[test]
fn an_unfilled_route_returns_the_whole_escrow_and_can_route_again() {
    let env = setup();
    let first = routed(env);
    from_omnibus(env, fill(first, 1, 0, 0, true));
    env.gateway.release(ORDER);
    assert(env.pool.get_order(ORDER).escrow_remaining == OFFER, 'escrow');
    let second = route(env);
    assert(second != first, 'same route id');
    assert(env.gateway.route_of(second).status == ROUTE_OPEN, 'second route');
}

#[test]
fn the_keeper_cancels_a_route() {
    let env = setup();
    let route_id = routed(env);
    fund_and_approve(env, keeper(), LZ_FEE);
    start_cheat_caller_address(env.gateway.contract_address, keeper());
    env.gateway.cancel_route(ORDER, 0, fee());
    stop_cheat_caller_address(env.gateway.contract_address);
    assert(env.endpoint.last_message() == encode_cancel(route_id), 'cancel message');
    assert(env.gateway.route_of(route_id).cancel_requested, 'not marked');
}

#[test]
#[should_panic(expected: 'HV_NOT_EXPIRED')]
fn a_stranger_cannot_cancel_before_expiry() {
    let env = setup();
    routed(env);
    fund_and_approve(env, stranger(), LZ_FEE);
    start_cheat_caller_address(env.gateway.contract_address, stranger());
    env.gateway.cancel_route(ORDER, 0, fee());
}

#[test]
fn anyone_pulls_an_expired_order_back() {
    let env = setup();
    let route_id = routed(env);
    start_cheat_block_timestamp_global(EXPIRY + 1);
    fund_and_approve(env, stranger(), LZ_FEE);
    start_cheat_caller_address(env.gateway.contract_address, stranger());
    env.gateway.cancel_route(ORDER, 0, fee());
    assert(env.endpoint.last_message() == encode_cancel(route_id), 'cancel message');
}

// ── Exits ────────────────────────────────────────────────────────────────────
//
// Through the pool's own invoke, proven for real: the user (KYC'd, registered,
// holding the USDC twin credited by a real deposit) pays the gateway
// `amount + 1` and gets 1 unit back as change into an open note. The exit
// names the user's empty real-USDC open note in the same pool, whose WITHDRAW
// fee was prepaid from the user's STRK in the pool; the vault fills that note
// when Circle's message arrives.

const CREDITED: u128 = 24_990_000_000; // 249.9 USDC, 8 dp
const EXIT_AMOUNT: u128 = 10_000_000_000; // 100 USDC, 8 dp
const EXIT_AMOUNT6: u128 = 100_000_000;

// A user holding CREDITED of the USDC twin, from a real deposit.
fn twin_holder(env: Env) {
    let (_, deposit_id) = deposited(env);
    from_omnibus(env, encode_credit(deposit_id, CREDITED));
}

// The user's empty real-USDC note an exit fills, prepaid for its WITHDRAW.
fn usdc_note_ready(env: Env) -> felt252 {
    let usdc_note = create_open_note(env.pool, maker(), USER_KEY, env.usdc);
    pay_fee(env, FUND_NOTE, usdc_note, LZ_FEE.low);
    usdc_note
}

fn from_hyperliquid(env: Env, amount: u128, usdc_note: felt252) -> InvokeSwap {
    invoke_same(
        env, env.usdc_twin, amount + 1, env.gateway.contract_address,
        array![amount.into(), usdc_note, 0],
    )
}

fn first_exit_id(env: Env) -> felt252 {
    poseidon_hash_span(array!['HV_EXIT', env.gateway.contract_address.into(), 1].span())
}

fn exited(env: Env) -> (felt252, felt252) {
    twin_holder(env);
    let usdc_note = usdc_note_ready(env);
    from_hyperliquid(env, EXIT_AMOUNT, usdc_note);
    (first_exit_id(env), usdc_note)
}

#[test]
fn an_exit_is_one_proven_invoke_that_burns_the_twin_and_tells_the_omnibus() {
    let env = setup();
    twin_holder(env);
    let usdc_note = usdc_note_ready(env);
    let msg = from_hyperliquid(env, EXIT_AMOUNT, usdc_note);
    let exit_id = first_exit_id(env);

    assert(note_value(env, msg.open_note_id) == TWO_POW_128 + 1, 'change not returned');
    // The pool keeps what was not exited; nothing is left on the gateway.
    assert(
        balance(env.usdc_twin, env.pool.contract_address) == (CREDITED - EXIT_AMOUNT).into(),
        'pool balance',
    );
    assert(balance(env.usdc_twin, env.gateway.contract_address) == 0, 'gateway kept twin');

    let record = env.vault.exit_of(exit_id);
    assert(record.status == EXIT_REGISTERED, 'not registered');
    assert(record.note_id == usdc_note && record.expected == EXIT_AMOUNT6, 'exit record');
    assert(env.vault.exit_of_note(usdc_note) == exit_id, 'note not claimed');
    assert(env.endpoint.last_message() == encode_withdraw(exit_id, EXIT_AMOUNT), 'withdraw msg');
    assert(env.gateway.note_credit(usdc_note) == 0, 'fee not taken from credit');
}

#[test]
#[should_panic(expected: 'HV_FEE_UNFUNDED')]
fn an_exit_whose_note_prepaid_nothing_does_not_happen() {
    let env = setup();
    twin_holder(env);
    let usdc_note = create_open_note(env.pool, maker(), USER_KEY, env.usdc);
    from_hyperliquid(env, EXIT_AMOUNT, usdc_note);
}

#[test]
#[should_panic(expected: 'HV_EXIT_NOT_WHOLE_UNITS')]
fn an_exit_is_a_whole_number_of_cctp_units() {
    let env = setup();
    twin_holder(env);
    let usdc_note = usdc_note_ready(env);
    from_hyperliquid(env, EXIT_AMOUNT + 1, usdc_note);
}

#[test]
#[should_panic(expected: 'HV_NOT_USDC_NOTE')]
fn an_exit_must_name_a_real_usdc_note() {
    let env = setup();
    twin_holder(env);
    seed_open_note(env, 'TWIN_NOTE', env.usdc_twin);
    from_hyperliquid(env, EXIT_AMOUNT, 'TWIN_NOTE');
}

#[test]
#[should_panic(expected: 'HV_NOTE_NOT_EMPTY')]
fn an_exit_must_name_an_empty_note() {
    let env = setup();
    twin_holder(env);
    seed_open_note(env, 'USDC_NOTE', env.usdc);
    store(
        env.pool.contract_address,
        map_entry_address(selector!("notes"), array!['USDC_NOTE'].span()),
        array![TWO_POW_128 + 5].span(),
    );
    from_hyperliquid(env, EXIT_AMOUNT, 'USDC_NOTE');
}

#[test]
#[should_panic(expected: 'HV_NOTE_CLAIMED')]
fn two_exits_cannot_name_the_same_note() {
    let env = setup();
    twin_holder(env);
    let usdc_note = usdc_note_ready(env);
    from_hyperliquid(env, EXIT_AMOUNT, usdc_note);
    from_hyperliquid(env, EXIT_AMOUNT, usdc_note);
}

#[test]
#[should_panic(expected: 'ONLY_POOL')]
fn only_the_pool_runs_an_exit() {
    let env = setup();
    hyperveil::gateway::IHyperVeilExitAdapterDispatcher { contract_address: env.gateway.contract_address }
        .privacy_invoke(1, EXIT_AMOUNT, 'USDC_NOTE', 0);
}

#[test]
#[should_panic(expected: 'HV_EXIT_NOT_PAID')]
fn an_exit_cannot_take_twins_held_for_receipts() {
    let env = setup();
    twin_holder(env);
    let usdc_note = usdc_note_ready(env);
    // Pretend a sell's USDC delivery waits in custody: the exit may not use it.
    store(
        env.gateway.contract_address,
        map_entry_address(selector!("reserved"), array![env.usdc_twin.into()].span()),
        array![(EXIT_AMOUNT * 10).into(), 0].span(),
    );
    from_hyperliquid(env, EXIT_AMOUNT, usdc_note);
}

#[test]
#[should_panic(expected: 'ONLY_GATEWAY')]
fn only_the_gateway_registers_exits() {
    let env = setup();
    env.vault.register_exit('EXIT', 'USDC_NOTE', EXIT_AMOUNT6);
}

// Circle's attested burn message, as the omnibus's CCTP burn produces it.
fn exit_message(env: Env, exit_id: felt252, amount6: u128, sender: u256, domain: u32) -> ByteArray {
    let vault: felt252 = env.vault.contract_address.into();
    let vault: u256 = vault.into();
    let mut m: ByteArray = Default::default();
    append_be(ref m, 1, 4); // version
    append_be(ref m, domain.into(), 4); // source domain
    append_be(ref m, 25, 4); // destination domain (Starknet)
    append_u256(ref m, 0x99); // nonce
    append_u256(ref m, 0x28b5a0e9); // sender: HyperEVM TokenMessengerV2
    append_u256(ref m, 0x07d421b9); // recipient: Starknet TokenMessengerMinterV2
    append_u256(ref m, vault); // destination caller
    append_be(ref m, 2000, 4);
    append_be(ref m, 2000, 4);
    append_be(ref m, 1, 4); // burn message version
    append_u256(ref m, 0xb88339cb); // burn token (HyperEVM USDC)
    append_u256(ref m, vault); // mint recipient
    append_u256(ref m, amount6.into());
    append_u256(ref m, sender); // message sender
    append_u256(ref m, 0); // max fee
    append_u256(ref m, 0); // fee executed
    append_u256(ref m, 0); // expiration block
    append_u256(ref m, exit_id.into()); // hook data
    m
}

fn relay_exit(env: Env, exit_id: felt252) {
    env.vault.receive_exit(exit_message(env, exit_id, EXIT_AMOUNT6, OMNIBUS, 19), "ATTESTED");
}

#[test]
fn the_vault_fills_the_users_usdc_note_when_the_cctp_mint_arrives() {
    let env = setup();
    let (exit_id, usdc_note) = exited(env);
    let pool_usdc = balance(env.usdc, env.pool.contract_address);
    relay_exit(env, exit_id);

    let exit = env.vault.exit_of(exit_id);
    assert(exit.status == EXIT_DELIVERED && exit.funded == EXIT_AMOUNT6, 'not delivered');
    assert(note_value(env, usdc_note) == TWO_POW_128 + EXIT_AMOUNT6.into(), 'note not filled');
    assert(balance(env.usdc, env.vault.contract_address) == 0, 'vault kept usdc');
    assert(
        balance(env.usdc, env.pool.contract_address) == pool_usdc + EXIT_AMOUNT6.into(), 'pool usdc',
    );
}

#[test]
fn a_delivery_the_pool_refuses_is_quarantined_and_retried() {
    let env = setup();
    let (exit_id, usdc_note) = exited(env);
    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.pause();
    stop_cheat_caller_address(env.pool.contract_address);

    relay_exit(env, exit_id);
    assert(env.vault.exit_of(exit_id).status == EXIT_FUNDED, 'not quarantined');
    assert(balance(env.usdc, env.vault.contract_address) == EXIT_AMOUNT6.into(), 'vault usdc');

    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.unpause();
    stop_cheat_caller_address(env.pool.contract_address);
    env.vault.retry_delivery(exit_id);
    assert(env.vault.exit_of(exit_id).status == EXIT_DELIVERED, 'not delivered');
    assert(note_value(env, usdc_note) == TWO_POW_128 + EXIT_AMOUNT6.into(), 'note not filled');
}

#[test]
#[should_panic(expected: 'EXIT_NOT_FUNDED')]
fn a_delivered_exit_is_not_delivered_again() {
    let env = setup();
    let (exit_id, _) = exited(env);
    relay_exit(env, exit_id);
    env.vault.retry_delivery(exit_id);
}

#[test]
#[should_panic(expected: 'EXIT_NOT_FUNDED')]
fn nothing_is_delivered_before_the_usdc_arrives() {
    let env = setup();
    let (exit_id, _) = exited(env);
    env.vault.retry_delivery(exit_id);
}

#[test]
#[should_panic(expected: 'NOT_FROM_OMNIBUS')]
fn a_burn_not_made_by_the_omnibus_funds_nothing() {
    let env = setup();
    let (exit_id, _) = exited(env);
    env.vault.receive_exit(exit_message(env, exit_id, EXIT_AMOUNT6, 0x2222, 19), "ATTESTED");
}

#[test]
#[should_panic(expected: 'WRONG_SOURCE_DOMAIN')]
fn a_burn_from_another_chain_funds_nothing() {
    let env = setup();
    let (exit_id, _) = exited(env);
    env.vault.receive_exit(exit_message(env, exit_id, EXIT_AMOUNT6, OMNIBUS, 0), "ATTESTED");
}

#[test]
#[should_panic(expected: 'EXIT_NOT_AWAITING_FUNDS')]
fn an_exit_is_funded_once() {
    let env = setup();
    let (exit_id, _) = exited(env);
    relay_exit(env, exit_id);
    relay_exit(env, exit_id);
}
