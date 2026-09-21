// HyperVeilStrk20Entry — moves a token from a user's private STRK20 balance
// into their Veil pool balance without touching a public wallet.
//
// One STRK20 transaction (StarkWare's privacy pool, its own action phases):
//   UseNote...            spend the user's STRK20 notes of `token`
//   Withdraw -> entry     `amount` of `token` to this contract
//   Invoke entry          `privacy_invoke(token, veil_note_id, amount)` below
// and `privacy_invoke` fills the user's empty open note of `token` in the Veil
// pool (created beforehand with a proven `create_open_note`). The STRK20 pool
// pays this contract and calls it, the Veil pool pulls from it; the user is on
// neither chain record. It returns no STRK20 deposits.
//
// Any token the Veil pool accepts works (HyperVeil uses it for USDC and for the
// STRK that pays fees). The Veil pool enforces what matters: the note must be
// an empty open note of that token, and this contract must be one of its
// allowed adapters.
//
// Stateless, no admin: a transfer that fails anywhere reverts the whole STRK20
// transaction.

use starknet::ContractAddress;
use super::interfaces::OpenNoteDeposit;

#[starknet::interface]
pub trait IHyperVeilStrk20Entry<TContractState> {
    /// The STRK20 pool only (Invoke action, selector `privacy_invoke`). The
    /// STRK20 pool has just paid this contract `amount` of `token`.
    fn privacy_invoke(
        ref self: TContractState, token: ContractAddress, veil_note_id: felt252, amount: u128,
    ) -> Span<OpenNoteDeposit>;
    fn strk20_pool(self: @TContractState) -> ContractAddress;
    fn veil_pool(self: @TContractState) -> ContractAddress;
}

#[starknet::contract]
pub mod HyperVeilStrk20Entry {
    use core::num::traits::Zero;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::interfaces::{
        IERC20Dispatcher, IERC20DispatcherTrait, IVeilPoolDispatcher, IVeilPoolDispatcherTrait,
        OpenNoteDeposit,
    };
    use super::IHyperVeilStrk20Entry;

    #[storage]
    struct Storage {
        strk20_pool: ContractAddress,
        veil_pool: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, strk20_pool: ContractAddress, veil_pool: ContractAddress,
    ) {
        assert(!strk20_pool.is_zero(), 'ZERO_STRK20_POOL');
        assert(!veil_pool.is_zero(), 'ZERO_VEIL_POOL');
        self.strk20_pool.write(strk20_pool);
        self.veil_pool.write(veil_pool);
    }

    #[abi(embed_v0)]
    impl Strk20EntryImpl of IHyperVeilStrk20Entry<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, token: ContractAddress, veil_note_id: felt252, amount: u128,
        ) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.strk20_pool.read(), 'ONLY_STRK20_POOL');
            assert(amount != 0, 'ZERO_AMOUNT');
            let this = get_contract_address();
            let erc20 = IERC20Dispatcher { contract_address: token };
            let before = erc20.balance_of(this);
            assert(before >= amount.into(), 'TOKEN_NOT_RECEIVED');

            let veil_pool = self.veil_pool.read();
            erc20.approve(veil_pool, amount.into());
            IVeilPoolDispatcher { contract_address: veil_pool }
                .fill_open_note(veil_note_id, token, amount);
            assert(erc20.balance_of(this) == before - amount.into(), 'VEIL_TOOK_NOTHING');
            array![].span()
        }

        fn strk20_pool(self: @ContractState) -> ContractAddress {
            self.strk20_pool.read()
        }
        fn veil_pool(self: @ContractState) -> ContractAddress {
            self.veil_pool.read()
        }
    }
}
