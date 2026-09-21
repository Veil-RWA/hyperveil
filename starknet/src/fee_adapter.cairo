// HyperVeilFeeAdapter — how a user pays HyperVeil's LayerZero fees from STRK
// held inside the Veil pool.
//
// One proven pool `invoke` (in token = out token = STRK, adapter = this
// contract) spends `amount + 1` STRK, pays it here and calls `privacy_invoke`,
// which prepays the gateway:
//   * `FUND_ORDER`: the routing and cancel fees of the Veil order `key`
//     (`gateway.fund_order`);
//   * `FUND_NOTE`: the DEPOSIT fee of the deposit that credits note `key`, or
//     the WITHDRAW fee of the exit that fills it (`gateway.fund_note`);
// and hands 1 unit back into the invoke's open note (a pool invoke must return
// a non-zero deposit). The payer stays hidden: the chain sees the pool pay this
// adapter and the adapter fund an order or a note.
//
// Stateless, no admin, nothing to rescue: a payment that fails anywhere reverts
// the whole invoke.

use starknet::ContractAddress;
use super::interfaces::OpenNoteDeposit;

pub const FUND_ORDER: u8 = 0;
pub const FUND_NOTE: u8 = 1;
/// What a payment hands back into the invoke's open note.
pub const FEE_CHANGE: u128 = 1;

#[starknet::interface]
pub trait IHyperVeilFeeAdapter<TContractState> {
    /// The gateway's Veil pool only (invoke adapter, selector `privacy_invoke`).
    /// The pool has just paid this contract `amount + 1` STRK. `target` is
    /// `FUND_ORDER` (key = order id) or `FUND_NOTE` (key = note id).
    fn privacy_invoke(
        ref self: TContractState, open_note_id: felt252, target: u8, key: felt252, amount: u128,
    ) -> Array<OpenNoteDeposit>;
    fn gateway(self: @TContractState) -> ContractAddress;
    fn strk(self: @TContractState) -> ContractAddress;
}

#[starknet::contract]
pub mod HyperVeilFeeAdapter {
    use core::num::traits::Zero;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::gateway::{IHyperVeilGatewayDispatcher, IHyperVeilGatewayDispatcherTrait};
    use crate::interfaces::{IERC20Dispatcher, IERC20DispatcherTrait, OpenNoteDeposit};
    use super::{FEE_CHANGE, FUND_NOTE, FUND_ORDER, IHyperVeilFeeAdapter};

    #[storage]
    struct Storage {
        gateway: ContractAddress,
        /// The gateway's fee token, read once at deployment.
        strk: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, gateway: ContractAddress) {
        assert(!gateway.is_zero(), 'ZERO_GATEWAY');
        let strk = IHyperVeilGatewayDispatcher { contract_address: gateway }.native_token();
        assert(!strk.is_zero(), 'ZERO_NATIVE_TOKEN');
        self.gateway.write(gateway);
        self.strk.write(strk);
    }

    #[abi(embed_v0)]
    impl FeeAdapterImpl of IHyperVeilFeeAdapter<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, open_note_id: felt252, target: u8, key: felt252, amount: u128,
        ) -> Array<OpenNoteDeposit> {
            let gateway_address = self.gateway.read();
            let gateway = IHyperVeilGatewayDispatcher { contract_address: gateway_address };
            let pool = gateway.pool();
            assert(get_caller_address() == pool, 'ONLY_POOL');
            assert(amount != 0, 'ZERO_AMOUNT');
            assert(target == FUND_ORDER || target == FUND_NOTE, 'HV_BAD_FEE_TARGET');
            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            // The pool paid `amount + change` just before this call.
            assert(
                strk.balance_of(get_contract_address()) >= amount.into() + FEE_CHANGE.into(),
                'STRK_NOT_RECEIVED',
            );

            strk.approve(gateway_address, amount.into());
            if target == FUND_ORDER {
                gateway.fund_order(key, amount.into());
            } else {
                gateway.fund_note(key, amount.into());
            }

            strk.approve(pool, FEE_CHANGE.into());
            array![
                OpenNoteDeposit { note_id: open_note_id, token: strk.contract_address, amount: FEE_CHANGE },
            ]
        }

        fn gateway(self: @ContractState) -> ContractAddress {
            self.gateway.read()
        }
        fn strk(self: @ContractState) -> ContractAddress {
            self.strk.read()
        }
    }
}
