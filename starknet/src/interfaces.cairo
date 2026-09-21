// Everything HyperVeil talks to on Starknet that it does not own: the Veil
// pool, Circle's CCTP, a SNIP-6 account, and the invoke return type shared by
// StarkWare's STRK20 pool and the Veil pool. Restated, not imported.
//
// The pool surface is a structural copy of `veil::interfaces::IVeilERC3643`
// (names, argument order and types must match exactly; the tests run against
// the real pool, so a drift fails there). CCTP is copied from Circle's
// `circlefin/starknet-cctp` (`packages/interfaces`), and `OpenNoteDeposit` from
// `starkware-libs/starknet-privacy` (`privacy::objects`).

use starknet::ContractAddress;

// ── Veil pool ────────────────────────────────────────────────────────────────

#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct EncUserAddr {
    pub auditor_public_key: felt252,
    pub ephemeral_pubkey: felt252,
    pub enc_user_addr: felt252,
}

#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct OrderRecord {
    pub maker_commitment: felt252,
    pub enc_maker: EncUserAddr,
    pub offer_token: ContractAddress,
    pub want_token: ContractAddress,
    pub offer_amount: u128,
    pub want_amount: u128,
    pub escrow_remaining: u128,
    pub received: u128,
    pub receive_note_id: felt252,
    pub expiry: u64,
    pub status: u8,
    pub maker_rules_hash: felt252,
}

pub const ORDER_OPEN: u8 = 0;

#[derive(Copy, Drop, Serde)]
pub struct OpenNoteRecord {
    pub token: ContractAddress,
}

#[derive(Copy, Drop, Serde)]
pub struct NoteRecord {
    pub encrypted_amount: felt252,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug, Default)]
pub struct VenueRoute {
    pub routed: bool,
    pub escrow: u128,
    pub drawn: u128,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct VenueReceipt {
    pub order_id: felt252,
    pub draw: u128,
    pub deliver: u128,
    pub pending: bool,
}

#[starknet::interface]
pub trait IVeilPool<TContractState> {
    fn get_order(self: @TContractState, order_id: felt252) -> OrderRecord;
    fn venue_route(ref self: TContractState, order_id: felt252) -> u128;
    fn venue_release(ref self: TContractState, order_id: felt252, refund: u128);
    fn get_venue_route(self: @TContractState, order_id: felt252) -> VenueRoute;
    fn fill_open_note(
        ref self: TContractState, note_id: felt252, token: ContractAddress, amount: u128,
    );
    fn get_open_note(self: @TContractState, note_id: felt252) -> OpenNoteRecord;
    fn get_notes_batch(self: @TContractState, note_ids: Array<felt252>) -> Array<NoteRecord>;
}

/// What the pool reads back from its venue. Implemented by the gateway.
#[starknet::interface]
pub trait IVeilVenue<TContractState> {
    fn venue_receipt(self: @TContractState, receipt_id: felt252) -> VenueReceipt;
    fn consume_venue_receipt(ref self: TContractState, receipt_id: felt252);
}

// ── Invoke adapters (STRK20 and Veil) ────────────────────────────────────────

/// `privacy::objects::OpenNoteDeposit`: what an invoked adapter returns for the
/// pool (STRK20's, or Veil's, which copies it) to pull into an open note
/// created in the same transaction.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

// ── Circle CCTP V2 on Starknet ───────────────────────────────────────────────

/// `TokenMessengerMinterV2` (burn side). Circle domains: Starknet 25, HyperEVM 19.
#[starknet::interface]
pub trait ITokenMessengerMinterV2<TContractState> {
    fn deposit_for_burn_with_hook(
        ref self: TContractState,
        amount: u256,
        destination_domain: u32,
        mint_recipient: u256,
        burn_token: ContractAddress,
        destination_caller: u256,
        max_fee: u256,
        min_finality_threshold: u32,
        hook_data: ByteArray,
    );
}

/// `MessageTransmitterV2` (receive side).
#[starknet::interface]
pub trait IMessageTransmitterV2<TContractState> {
    fn receive_message(
        ref self: TContractState, message: ByteArray, attestation: ByteArray,
    ) -> bool;
}

// ── Accounts and tokens ──────────────────────────────────────────────────────

/// SNIP-6. Returns 'VALID' (or starknet::VALIDATED) for a good signature.
#[starknet::interface]
pub trait ISRC6<TContractState> {
    fn is_valid_signature(
        self: @TContractState, hash: felt252, signature: Array<felt252>,
    ) -> felt252;
}

#[starknet::interface]
pub trait IERC20<TContractState> {
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
}

/// The permission manager's read side, as the pool and the twins ask it.
#[starknet::interface]
pub trait IVeilPermissionManager<TContractState> {
    fn has_role(self: @TContractState, role: felt252, account: ContractAddress) -> bool;
}

/// The twin's gateway-only supply controls.
#[starknet::interface]
pub trait IHyperVeilTwinMint<TContractState> {
    fn mint(ref self: TContractState, to: ContractAddress, amount: u256);
    fn burn(ref self: TContractState, from: ContractAddress, amount: u256);
}
