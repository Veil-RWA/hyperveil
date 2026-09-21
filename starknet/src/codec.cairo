// HyperVeil wire format: what the Starknet gateway and the HyperEVM omnibus
// say to each other over LayerZero.
//
// Packed big-endian, no padding, kind byte first — the same conventions as the
// Veil bridge (bridge/cairo/src/msg_codec.cairo). Mirrored in
// `hyperveil/evm/contracts/HyperVeilCodec.sol`; both test suites pin the same
// vectors, so a one-sided change fails a test rather than a testnet.
//
// | Kind | Direction | Bytes  | Payload                                                   |
// |------|-----------|--------|-----------------------------------------------------------|
// | 1 DEPOSIT  | SN -> HL | 49     | deposit_id, amount (USDC, 6 dp: the CCTP amount)     |
// | 2 PLACE    | SN -> HL | 135    | route_id, cloid, asset, is_buy, px, sz, tif,          |
// |            |          |        | offer_token, want_token, offer_amount, want_amount,  |
// |            |          |        | escrow                                               |
// | 3 CANCEL   | SN -> HL | 33     | route_id                                             |
// | 4 WITHDRAW | SN -> HL | 49     | exit_id, amount (USDC twin units = HyperCore wei)    |
// | 5 CREDIT   | HL -> SN | 49     | deposit_id, amount (USDC twin units)                 |
// | 6 FILL     | HL -> SN | 3+73n  | n x (route_id, seq, cum_draw, cum_deliver, closed)   |
//
// Units. A twin's smallest unit IS its HyperCore token's wei (`weiDecimals`),
// so every twin amount on the wire is a HyperCore wei amount and no side ever
// rescales. The one exception is DEPOSIT, which carries the CCTP amount in
// Circle's 6-decimal USDC units, because that is what was burned.
//
// `px` and `sz` are HyperCore order fields exactly as CoreWriter's limit-order
// action takes them: 10^8 x the human-readable value. `asset` is the spot asset
// id (10000 + spot index); `offer_token`/`want_token` are HyperCore token
// indices. `tif`: 1 Alo, 2 Gtc, 3 Ioc (CoreWriter's encoding).
//
// `route_id` names one trip of a Veil order to Hyperliquid:
// poseidon('HV_ROUTE', order_id, round). An order the venue returns unfilled
// can be routed again, and each trip is its own HyperCore order (its cloid is
// the route id's low 128 bits), so the two never share fills.
//
// FILL amounts are CUMULATIVE per route with a per-route `seq`, so a report
// that arrives late or twice (LayerZero is unordered here) is recognised and
// dropped instead of double-counted.

use super::bytes::{
    append_be, append_bool, append_u128, append_u16, append_u256, append_u64, append_u8,
    read_be, read_bool, read_u16, read_u256, read_u64, read_u8,
};

pub const KIND_DEPOSIT: u8 = 1;
pub const KIND_PLACE: u8 = 2;
pub const KIND_CANCEL: u8 = 3;
pub const KIND_WITHDRAW: u8 = 4;
pub const KIND_CREDIT: u8 = 5;
pub const KIND_FILL: u8 = 6;

pub const DEPOSIT_LEN: u32 = 49;
pub const PLACE_LEN: u32 = 135;
pub const CANCEL_LEN: u32 = 33;
pub const WITHDRAW_LEN: u32 = 49;
pub const CREDIT_LEN: u32 = 49;
pub const FILL_HEADER_LEN: u32 = 3;
pub const FILL_ITEM_LEN: u32 = 73;

pub const TIF_ALO: u8 = 1;
pub const TIF_GTC: u8 = 2;
pub const TIF_IOC: u8 = 3;

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Place {
    pub route_id: felt252,
    pub cloid: u128,
    pub asset: u32,
    pub is_buy: bool,
    pub px: u64,
    pub sz: u64,
    pub tif: u8,
    pub offer_token: u64,
    pub want_token: u64,
    pub offer_amount: u128,
    pub want_amount: u128,
    pub escrow: u128,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct FillItem {
    pub route_id: felt252,
    pub seq: u64,
    pub cum_draw: u128,
    pub cum_deliver: u128,
    pub closed: bool,
}

pub fn kind(message: @ByteArray) -> u8 {
    read_u8(message, 0)
}

fn append_id(ref buf: ByteArray, id: felt252) {
    append_u256(ref buf, id.into());
}

// A 32-byte id from the EVM side must be a felt. Anything larger can only come
// from a broken peer, so it is a protocol error.
fn read_id(buf: @ByteArray, offset: u32) -> felt252 {
    read_u256(buf, offset).try_into().expect('HV_ID_NOT_FELT')
}

fn read_u128_at(buf: @ByteArray, offset: u32) -> u128 {
    read_be(buf, offset, 16).low
}

fn read_u32_at(buf: @ByteArray, offset: u32) -> u32 {
    read_be(buf, offset, 4).low.try_into().unwrap()
}

fn assert_len(buf: @ByteArray, expected: u32) {
    assert(buf.len() == expected, 'HV_BAD_LENGTH');
}

// ── Starknet -> HyperEVM ────────────────────────────────────────────────────

pub fn encode_deposit(deposit_id: felt252, amount_usdc6: u128) -> ByteArray {
    let mut buf: ByteArray = Default::default();
    append_u8(ref buf, KIND_DEPOSIT);
    append_id(ref buf, deposit_id);
    append_u128(ref buf, amount_usdc6);
    buf
}

pub fn decode_deposit(buf: @ByteArray) -> (felt252, u128) {
    assert_len(buf, DEPOSIT_LEN);
    assert(kind(buf) == KIND_DEPOSIT, 'HV_BAD_KIND');
    (read_id(buf, 1), read_u128_at(buf, 33))
}

pub fn encode_place(p: @Place) -> ByteArray {
    let mut buf: ByteArray = Default::default();
    append_u8(ref buf, KIND_PLACE);
    append_id(ref buf, *p.route_id);
    append_u128(ref buf, *p.cloid);
    append_be(ref buf, (*p.asset).into(), 4);
    append_bool(ref buf, *p.is_buy);
    append_u64(ref buf, *p.px);
    append_u64(ref buf, *p.sz);
    append_u8(ref buf, *p.tif);
    append_u64(ref buf, *p.offer_token);
    append_u64(ref buf, *p.want_token);
    append_u128(ref buf, *p.offer_amount);
    append_u128(ref buf, *p.want_amount);
    append_u128(ref buf, *p.escrow);
    buf
}

pub fn decode_place(buf: @ByteArray) -> Place {
    assert_len(buf, PLACE_LEN);
    assert(kind(buf) == KIND_PLACE, 'HV_BAD_KIND');
    Place {
        route_id: read_id(buf, 1),
        cloid: read_u128_at(buf, 33),
        asset: read_u32_at(buf, 49),
        is_buy: read_bool(buf, 53),
        px: read_u64(buf, 54),
        sz: read_u64(buf, 62),
        tif: read_u8(buf, 70),
        offer_token: read_u64(buf, 71),
        want_token: read_u64(buf, 79),
        offer_amount: read_u128_at(buf, 87),
        want_amount: read_u128_at(buf, 103),
        escrow: read_u128_at(buf, 119),
    }
}

pub fn encode_cancel(route_id: felt252) -> ByteArray {
    let mut buf: ByteArray = Default::default();
    append_u8(ref buf, KIND_CANCEL);
    append_id(ref buf, route_id);
    buf
}

pub fn decode_cancel(buf: @ByteArray) -> felt252 {
    assert_len(buf, CANCEL_LEN);
    assert(kind(buf) == KIND_CANCEL, 'HV_BAD_KIND');
    read_id(buf, 1)
}

pub fn encode_withdraw(exit_id: felt252, amount: u128) -> ByteArray {
    let mut buf: ByteArray = Default::default();
    append_u8(ref buf, KIND_WITHDRAW);
    append_id(ref buf, exit_id);
    append_u128(ref buf, amount);
    buf
}

pub fn decode_withdraw(buf: @ByteArray) -> (felt252, u128) {
    assert_len(buf, WITHDRAW_LEN);
    assert(kind(buf) == KIND_WITHDRAW, 'HV_BAD_KIND');
    (read_id(buf, 1), read_u128_at(buf, 33))
}

// ── HyperEVM -> Starknet ────────────────────────────────────────────────────

pub fn encode_credit(deposit_id: felt252, amount: u128) -> ByteArray {
    let mut buf: ByteArray = Default::default();
    append_u8(ref buf, KIND_CREDIT);
    append_id(ref buf, deposit_id);
    append_u128(ref buf, amount);
    buf
}

pub fn decode_credit(buf: @ByteArray) -> (felt252, u128) {
    assert_len(buf, CREDIT_LEN);
    assert(kind(buf) == KIND_CREDIT, 'HV_BAD_KIND');
    (read_id(buf, 1), read_u128_at(buf, 33))
}

pub fn encode_fill(items: Span<FillItem>) -> ByteArray {
    let mut buf: ByteArray = Default::default();
    append_u8(ref buf, KIND_FILL);
    append_u16(ref buf, items.len().try_into().unwrap());
    for item in items {
        append_id(ref buf, *item.route_id);
        append_u64(ref buf, *item.seq);
        append_u128(ref buf, *item.cum_draw);
        append_u128(ref buf, *item.cum_deliver);
        append_bool(ref buf, *item.closed);
    }
    buf
}

pub fn decode_fill(buf: @ByteArray) -> Array<FillItem> {
    assert(kind(buf) == KIND_FILL, 'HV_BAD_KIND');
    let count: u32 = read_u16(buf, 1).into();
    assert(count > 0, 'HV_EMPTY_FILL');
    assert_len(buf, FILL_HEADER_LEN + count * FILL_ITEM_LEN);
    let mut items: Array<FillItem> = array![];
    let mut i: u32 = 0;
    while i != count {
        let at = FILL_HEADER_LEN + i * FILL_ITEM_LEN;
        items
            .append(
                FillItem {
                    route_id: read_id(buf, at),
                    seq: read_u64(buf, at + 32),
                    cum_draw: read_u128_at(buf, at + 40),
                    cum_deliver: read_u128_at(buf, at + 56),
                    closed: read_bool(buf, at + 72),
                },
            );
        i += 1;
    }
    items
}
