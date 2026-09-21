// LayerZero V2 types and endpoint ABI, redeclared locally — the same structural
// copy the Veil bridge uses (bridge/cairo/src/lz.cairo, read against
// `@layerzerolabs/protocol-starknet-v2` v1.2.33), for the same toolchain reason.
//
// Deployed endpoints (LayerZero metadata API, verified 2026-09-19):
//   Starknet mainnet  eid 30500  0x0524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68
//   Starknet sepolia  eid 40500  0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878
//   HyperEVM mainnet  eid 30367  0x3a73033c0b1407574c76bdbac67f126f6b4a9aa9
//   HyperEVM testnet  eid 40362  0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1

use starknet::ContractAddress;
use super::bytes::{append_u128, append_u16, append_u8};

/// LayerZero's 32-byte address word. Starknet addresses convert directly;
/// EVM addresses are the 20-byte value left-padded to 32.
#[derive(Copy, Drop, Serde, PartialEq, Debug, Default, starknet::Store)]
pub struct Bytes32 {
    pub value: u256,
}

pub impl ContractAddressIntoBytes32 of Into<ContractAddress, Bytes32> {
    fn into(self: ContractAddress) -> Bytes32 {
        let as_felt: felt252 = self.into();
        Bytes32 { value: as_felt.into() }
    }
}

#[derive(Copy, Drop, Serde, PartialEq, Debug, Default)]
pub struct Origin {
    pub src_eid: u32,
    pub sender: Bytes32,
    pub nonce: u64,
}

#[derive(Drop, Serde, Clone, PartialEq, Debug, Default)]
pub struct MessagingParams {
    pub dst_eid: u32,
    pub receiver: Bytes32,
    pub message: ByteArray,
    pub options: ByteArray,
    pub pay_in_lz_token: bool,
}

#[derive(Copy, Drop, Serde, Default, PartialEq, Debug)]
pub struct MessagingFee {
    pub native_fee: u256,
    pub lz_token_fee: u256,
}

#[derive(Drop, Clone, Serde, PartialEq, Debug)]
pub struct Payee {
    pub receiver: ContractAddress,
    pub native_amount: u256,
    pub lz_token_amount: u256,
}

#[derive(Drop, Serde, Default, PartialEq, Debug)]
pub struct MessageReceipt {
    pub guid: Bytes32,
    pub nonce: u64,
    pub payees: Array<Payee>,
}

#[starknet::interface]
pub trait IEndpointV2<TContractState> {
    fn send(
        ref self: TContractState, params: MessagingParams, refund_address: ContractAddress,
    ) -> MessageReceipt;
    fn quote(
        self: @TContractState, params: MessagingParams, sender: ContractAddress,
    ) -> MessagingFee;
    fn set_delegate(ref self: TContractState, delegate: ContractAddress);
}

#[starknet::interface]
pub trait ILayerZeroReceiver<TContractState> {
    fn lz_receive(
        ref self: TContractState,
        origin: Origin,
        guid: Bytes32,
        message: ByteArray,
        executor: ContractAddress,
        extra_data: ByteArray,
        value: u256,
    );
    fn allow_initialize_path(self: @TContractState, origin: Origin) -> bool;
    fn next_nonce(self: @TContractState, src_eid: u32, sender: Bytes32) -> u64;
}

/// Type-3 executor options carrying one `lzReceive` option: a gas limit and,
/// when `value` is non-zero, a native amount the executor hands the receiver on
/// the destination chain.
///
/// That value is how a Starknet user pays for the answer as well as the
/// question: HyperVeil's omnibus replies to every instruction (a credit, a
/// fill), and the HYPE it pays LayerZero with arrives here, as `value`, bought
/// with the STRK the user paid for the outbound message.
///
/// Layout (LayerZero `ExecutorOptions.encodeLzReceiveOption`):
///   u16  3        options type
///   u8   1        executor worker id
///   u16  n        option body length, including its type byte
///   u8   1        lzReceive option
///   u128 gas
///   u128 value    only when non-zero
pub fn build_lz_receive_options(gas_limit: u128, value: u128) -> ByteArray {
    let mut params: ByteArray = Default::default();
    append_u128(ref params, gas_limit);
    if value != 0 {
        append_u128(ref params, value);
    }

    let mut options: ByteArray = Default::default();
    append_u16(ref options, 3);
    append_u8(ref options, 1);
    let body_len: u16 = (params.len() + 1).try_into().unwrap();
    append_u16(ref options, body_len);
    append_u8(ref options, 1);
    options.append(@params);
    options
}
