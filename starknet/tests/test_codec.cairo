// The wire format, pinned byte for byte. The same hex vectors are asserted by
// hyperveil/evm/test/codec.test.js against HyperVeilCodec.sol, so the Cairo and
// Solidity codecs cannot drift apart without a test failing on one side.

use hyperveil::codec::{
    FillItem, KIND_FILL, Place, decode_cancel, decode_credit, decode_deposit, decode_fill,
    decode_place, decode_withdraw, encode_cancel, encode_credit, encode_deposit, encode_fill,
    encode_place, encode_withdraw, kind,
};
use hyperveil::lz::build_lz_receive_options;

pub fn hex(bytes: @ByteArray) -> ByteArray {
    let digits: ByteArray = "0123456789abcdef";
    let mut out: ByteArray = "0x";
    let mut i = 0;
    while i != bytes.len() {
        let b = bytes.at(i).unwrap();
        out.append_byte(digits.at((b / 16).into()).unwrap());
        out.append_byte(digits.at((b % 16).into()).unwrap());
        i += 1;
    }
    out
}

fn deposit_vector() -> ByteArray {
    "0x010000000000000000000000000000000000000000000000000123456789abcdef0000000000000000000000000ee6b280"
}

fn place_value() -> Place {
    Place {
        route_id: 0xabc,
        cloid: 0xabc,
        asset: 10107,
        is_buy: true,
        px: 2_512_300_000,
        sz: 1_000_000_000,
        tif: 2,
        offer_token: 0,
        want_token: 150,
        offer_amount: 25_123_000_000,
        want_amount: 1_000_000_000,
        escrow: 25_123_000_000,
    }
}

fn place_vector() -> ByteArray {
    "0x020000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000abc0000277b010000000095bea7e0000000003b9aca000200000000000000000000000000000096000000000000000000000005d9728ec00000000000000000000000003b9aca00000000000000000000000005d9728ec0"
}

fn fill_value() -> Array<FillItem> {
    array![
        FillItem {
            route_id: 0xabc,
            seq: 3,
            cum_draw: 12_000_000_000,
            cum_deliver: 500_000_000,
            closed: false,
        },
        FillItem { route_id: 0xdef, seq: 7, cum_draw: 0, cum_deliver: 0, closed: true },
    ]
}

fn fill_vector() -> ByteArray {
    "0x0600020000000000000000000000000000000000000000000000000000000000000abc0000000000000003000000000000000000000002cb4178000000000000000000000000001dcd6500000000000000000000000000000000000000000000000000000000000000000def0000000000000007000000000000000000000000000000000000000000000000000000000000000001"
}

#[test]
fn deposit_matches_the_pinned_vector_and_round_trips() {
    let encoded = encode_deposit(0x0123456789abcdef, 250_000_000);
    assert(encoded.len() == 49, 'length');
    assert(hex(@encoded) == deposit_vector(), 'deposit bytes');
    let (id, amount) = decode_deposit(@encoded);
    assert(id == 0x0123456789abcdef && amount == 250_000_000, 'deposit round trip');
}

#[test]
fn place_matches_the_pinned_vector_and_round_trips() {
    let encoded = encode_place(@place_value());
    assert(encoded.len() == 135, 'length');
    assert(hex(@encoded) == place_vector(), 'place bytes');
    assert(decode_place(@encoded) == place_value(), 'place round trip');
}

#[test]
fn cancel_matches_the_pinned_vector() {
    let encoded = encode_cancel(0xabc);
    assert(
        hex(@encoded) == "0x030000000000000000000000000000000000000000000000000000000000000abc",
        'cancel bytes',
    );
    assert(decode_cancel(@encoded) == 0xabc, 'cancel round trip');
}

#[test]
fn withdraw_matches_the_pinned_vector() {
    let encoded = encode_withdraw(0xe417, 10_000_000_000);
    assert(
        hex(@encoded) == "0x04000000000000000000000000000000000000000000000000000000000000e417000000000000000000000002540be400",
        'withdraw bytes',
    );
    let (id, amount) = decode_withdraw(@encoded);
    assert(id == 0xe417 && amount == 10_000_000_000, 'withdraw round trip');
}

#[test]
fn credit_matches_the_pinned_vector() {
    let encoded = encode_credit(0x0123456789abcdef, 24_990_000_000);
    assert(
        hex(@encoded) == "0x050000000000000000000000000000000000000000000000000123456789abcdef000000000000000000000005d1852380",
        'credit bytes',
    );
    let (id, amount) = decode_credit(@encoded);
    assert(id == 0x0123456789abcdef && amount == 24_990_000_000, 'credit round trip');
}

#[test]
fn fill_matches_the_pinned_vector_and_round_trips() {
    let encoded = encode_fill(fill_value().span());
    assert(kind(@encoded) == KIND_FILL, 'kind');
    assert(encoded.len() == 3 + 2 * 73, 'length');
    assert(hex(@encoded) == fill_vector(), 'fill bytes');
    assert(decode_fill(@encoded) == fill_value(), 'fill round trip');
}

#[test]
#[should_panic(expected: 'HV_BAD_LENGTH')]
fn a_truncated_fill_is_a_protocol_error() {
    let mut encoded = encode_fill(fill_value().span());
    let mut short: ByteArray = Default::default();
    let mut i = 0;
    while i != encoded.len() - 1 {
        short.append_byte(encoded.at(i).unwrap());
        i += 1;
    }
    decode_fill(@short);
}

#[test]
#[should_panic(expected: 'HV_EMPTY_FILL')]
fn an_empty_fill_is_a_protocol_error() {
    decode_fill(@encode_fill(array![].span()));
}

#[test]
#[should_panic(expected: 'HV_ID_NOT_FELT')]
fn an_id_above_the_field_is_a_protocol_error() {
    let mut buf: ByteArray = Default::default();
    buf.append_byte(3);
    let mut i = 0;
    while i != 32 {
        buf.append_byte(0xff);
        i += 1;
    }
    decode_cancel(@buf);
}

// Options: LayerZero type-3, one lzReceive option. With a value, the option
// body is 33 bytes (type + gas + value); without, 17.
#[test]
fn options_carry_gas_and_the_return_value() {
    assert(
        hex(@build_lz_receive_options(200_000, 0)) == "0x00030100110100000000000000000000000000030d40",
        'gas only',
    );
    assert(
        hex(
            @build_lz_receive_options(300_000, 1_000_000_000_000_000),
        ) == "0x000301002101000000000000000000000000000493e0000000000000000000038d7ea4c68000",
        'gas and value',
    );
}
