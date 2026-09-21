// HyperVeil — Starknet side.
//
// Private Hyperliquid spot trading through Veil: a Starknet user trades inside a
// Veil pool, the order is carried over LayerZero to an omnibus contract on
// HyperEVM that trades on HyperCore, and the result comes back into the user's
// private notes. See ../README.md.

pub mod bytes;
pub mod codec;
pub mod interfaces;
pub mod lz;
pub mod permission_manager;
pub mod twin;
pub mod gateway;
pub mod entry_helper;
pub mod exit_vault;
pub mod fee_adapter;
pub mod kyc_rules;
pub mod relay_endpoint;
pub mod strk20_entry;

// Test-only stand-ins (LayerZero endpoint, CCTP, STRK20 pool, ERC-20s). Under
// `src/` because snforge declares contracts from the compiled target.
pub mod mocks;
