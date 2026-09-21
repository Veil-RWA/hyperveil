// HyperVeilEntryHelper — how USDC held in the Veil pool leaves for HyperVeil.
//
// The user holds real USDC inside the HyperVeil Veil pool. One proven pool
// `invoke` (in token = out token = USDC, adapter = this contract) spends
// `amount + 1` of it, pays it here and calls `privacy_invoke`, which:
//   1. registers the deposit with the gateway, naming the user's empty
//      USDC-twin open note (the gateway claims the note and sends DEPOSIT to
//      the omnibus, paying from the STRK prepaid against that note);
//   2. burns `amount` through Circle CCTP to the omnibus on HyperEVM, with the
//      deposit id as hook data so the omnibus can match the arriving USDC to
//      the LayerZero instruction;
//   3. hands 1 unit back into the invoke's open note: a pool invoke must return
//      a non-zero deposit.
// So the user is never on-chain: the pool pays this contract and calls it, all
// inside one proven settle.
//
// Stateless by design, like StarkWare's anonymizers: the configuration is fixed
// at deployment and there is no admin. A deposit that fails anywhere reverts
// the whole invoke, so nothing is ever left here to rescue.

use starknet::ContractAddress;
use super::interfaces::OpenNoteDeposit;

/// Circle CCTP domain of HyperEVM.
pub const HYPEREVM_DOMAIN: u32 = 19;
/// What a deposit hands back into the invoke's open note.
pub const DEPOSIT_CHANGE: u128 = 1;

#[starknet::interface]
pub trait IHyperVeilEntryHelper<TContractState> {
    /// The gateway's Veil pool only (invoke adapter, selector `privacy_invoke`).
    /// The pool has just paid this contract `amount_usdc6 + 1` USDC.
    ///
    /// - `open_note_id`: the invoke's own open note (USDC), which gets the 1
    ///   unit of change.
    /// - `amount_usdc6`: USDC (6 dp) to send to Hyperliquid.
    /// - `twin_note_id`: the user's empty USDC-twin open note, credited once
    ///   the omnibus confirms.
    /// - `cctp_max_fee` / `min_finality`: CCTP transfer parameters (standard:
    ///   0 / 2000; fast: a fee / 1000).
    /// - `return_value`: HYPE (wei) delivered to the omnibus for its CREDIT.
    fn privacy_invoke(
        ref self: TContractState,
        open_note_id: felt252,
        amount_usdc6: u128,
        twin_note_id: felt252,
        cctp_max_fee: u256,
        min_finality: u32,
        return_value: u128,
    ) -> Array<OpenNoteDeposit>;
    fn gateway(self: @TContractState) -> ContractAddress;
    fn usdc(self: @TContractState) -> ContractAddress;
    fn token_messenger(self: @TContractState) -> ContractAddress;
    fn omnibus(self: @TContractState) -> u256;
}

#[starknet::contract]
pub mod HyperVeilEntryHelper {
    use core::num::traits::Zero;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::bytes::append_u256;
    use crate::gateway::{IHyperVeilGatewayDispatcher, IHyperVeilGatewayDispatcherTrait};
    use crate::interfaces::{
        IERC20Dispatcher, IERC20DispatcherTrait, ITokenMessengerMinterV2Dispatcher,
        ITokenMessengerMinterV2DispatcherTrait, OpenNoteDeposit,
    };
    use super::{DEPOSIT_CHANGE, HYPEREVM_DOMAIN, IHyperVeilEntryHelper};

    #[storage]
    struct Storage {
        gateway: ContractAddress,
        usdc: ContractAddress,
        token_messenger: ContractAddress,
        /// The omnibus's HyperEVM address, as CCTP's 32-byte word.
        omnibus: u256,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        DepositBurned: DepositBurned,
    }

    /// Deliberately carries no user: the deposit id and the amount are all the
    /// chain needs, and both are already public in the CCTP burn.
    #[derive(Drop, starknet::Event)]
    pub struct DepositBurned {
        #[key]
        pub deposit_id: felt252,
        pub amount_usdc6: u128,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        gateway: ContractAddress,
        usdc: ContractAddress,
        token_messenger: ContractAddress,
        omnibus: u256,
    ) {
        assert(!gateway.is_zero(), 'ZERO_GATEWAY');
        assert(!usdc.is_zero(), 'ZERO_USDC');
        assert(!token_messenger.is_zero(), 'ZERO_TOKEN_MESSENGER');
        assert(omnibus != 0 && omnibus.high < 0x100000000, 'BAD_OMNIBUS');
        self.gateway.write(gateway);
        self.usdc.write(usdc);
        self.token_messenger.write(token_messenger);
        self.omnibus.write(omnibus);
    }

    #[abi(embed_v0)]
    impl EntryHelperImpl of IHyperVeilEntryHelper<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            open_note_id: felt252,
            amount_usdc6: u128,
            twin_note_id: felt252,
            cctp_max_fee: u256,
            min_finality: u32,
            return_value: u128,
        ) -> Array<OpenNoteDeposit> {
            let gateway = IHyperVeilGatewayDispatcher { contract_address: self.gateway.read() };
            let pool = gateway.pool();
            assert(get_caller_address() == pool, 'ONLY_POOL');
            assert(amount_usdc6 != 0, 'ZERO_AMOUNT');
            let this = get_contract_address();
            let usdc = IERC20Dispatcher { contract_address: self.usdc.read() };
            let usdc_before = usdc.balance_of(this);
            // The pool paid `amount + change` just before this call (same
            // transaction, nothing in between).
            assert(
                usdc_before >= amount_usdc6.into() + DEPOSIT_CHANGE.into(), 'USDC_NOT_RECEIVED',
            );

            // 1. The instruction: claim the twin note, tell the omnibus.
            let deposit_id = gateway.register_deposit(twin_note_id, amount_usdc6, return_value);

            // 2. The value: burn through CCTP to the omnibus, which alone may
            //    relay the mint (destination caller), tagged with the deposit.
            let messenger = self.token_messenger.read();
            let omnibus = self.omnibus.read();
            let mut hook_data: ByteArray = Default::default();
            append_u256(ref hook_data, deposit_id.into());
            usdc.approve(messenger, amount_usdc6.into());
            ITokenMessengerMinterV2Dispatcher { contract_address: messenger }
                .deposit_for_burn_with_hook(
                    amount_usdc6.into(),
                    HYPEREVM_DOMAIN,
                    omnibus,
                    usdc.contract_address,
                    omnibus,
                    cctp_max_fee,
                    min_finality,
                    hook_data,
                );
            assert(
                usdc.balance_of(this) == usdc_before - amount_usdc6.into(), 'USDC_NOT_BURNED',
            );
            self.emit(DepositBurned { deposit_id, amount_usdc6 });

            // 3. The change goes back into the invoke's open note; the pool
            //    pulls it.
            usdc.approve(pool, DEPOSIT_CHANGE.into());
            array![
                OpenNoteDeposit {
                    note_id: open_note_id, token: usdc.contract_address, amount: DEPOSIT_CHANGE,
                },
            ]
        }

        fn gateway(self: @ContractState) -> ContractAddress {
            self.gateway.read()
        }
        fn usdc(self: @ContractState) -> ContractAddress {
            self.usdc.read()
        }
        fn token_messenger(self: @ContractState) -> ContractAddress {
            self.token_messenger.read()
        }
        fn omnibus(self: @ContractState) -> u256 {
            self.omnibus.read()
        }
    }
}
