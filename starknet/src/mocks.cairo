// TEST ONLY. Stand-ins for what HyperVeil talks to that is not in this repo:
// the LayerZero endpoint, Circle's CCTP contracts and FiatToken (USDC),
// StarkWare's STRK20 pool, and a plain ERC-20 for STRK. The Veil pool itself is NOT mocked — the
// tests deploy the real `VeilERC3643`.
//
// Each mock reproduces the one behaviour HyperVeil depends on, read from the
// real source:
//   * endpoint: pays its fee out of the sender's allowance and refunds the rest
//     to `refund_address` (LayerZero protocol-starknet-v2 1.2.33, `_pay_workers`);
//   * token messenger: `deposit_for_burn_with_hook` pulls and burns the amount;
//   * message transmitter: `receive_message` enforces the destination caller
//     and mints `amount - fee_executed` to the mint recipient, once;
//   * STRK20 pool: Withdraw pays the target, Invoke calls `privacy_invoke`, the
//     returned deposits are pulled into open notes created in the same
//     transaction, and every such note must be filled (UNDEPOSITED_OPEN_NOTES).

use starknet::ContractAddress;
use crate::lz::Bytes32;

#[starknet::interface]
pub trait IMockEndpoint<TContractState> {
    fn set_fee(ref self: TContractState, native_fee: u256);
    fn last_dst_eid(self: @TContractState) -> u32;
    fn last_message(self: @TContractState) -> ByteArray;
    fn last_options(self: @TContractState) -> ByteArray;
    fn last_refund_address(self: @TContractState) -> ContractAddress;
    fn send_count(self: @TContractState) -> u32;
    /// Delivers `message` to `receiver` as the endpoint would.
    fn deliver(
        ref self: TContractState,
        receiver: ContractAddress,
        src_eid: u32,
        sender: Bytes32,
        message: ByteArray,
    );
}

#[starknet::contract]
pub mod MockEndpoint {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::interfaces::{IERC20Dispatcher, IERC20DispatcherTrait};
    use crate::lz::{
        Bytes32, IEndpointV2, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait,
        MessageReceipt, MessagingFee, MessagingParams, Origin,
    };
    use super::IMockEndpoint;

    #[storage]
    struct Storage {
        native_token: ContractAddress,
        native_fee: u256,
        last_dst_eid: u32,
        last_message: ByteArray,
        last_options: ByteArray,
        last_refund_address: ContractAddress,
        send_count: u32,
        nonce: u64,
    }

    #[constructor]
    fn constructor(ref self: ContractState, native_token: ContractAddress) {
        self.native_token.write(native_token);
    }

    #[abi(embed_v0)]
    impl EndpointImpl of IEndpointV2<ContractState> {
        fn send(
            ref self: ContractState, params: MessagingParams, refund_address: ContractAddress,
        ) -> MessageReceipt {
            let sender = get_caller_address();
            let token = IERC20Dispatcher { contract_address: self.native_token.read() };
            let fee = self.native_fee.read();
            let allowance = token.allowance(sender, get_contract_address());
            assert(allowance >= fee, 'MOCK_FEE_NOT_SUPPLIED');
            if fee != 0 {
                token.transfer_from(sender, get_contract_address(), fee);
            }
            if allowance > fee {
                token.transfer_from(sender, refund_address, allowance - fee);
            }
            self.last_dst_eid.write(params.dst_eid);
            self.last_message.write(params.message);
            self.last_options.write(params.options);
            self.last_refund_address.write(refund_address);
            self.send_count.write(self.send_count.read() + 1);
            let nonce = self.nonce.read() + 1;
            self.nonce.write(nonce);
            MessageReceipt { guid: Bytes32 { value: nonce.into() }, nonce, payees: array![] }
        }

        fn quote(
            self: @ContractState, params: MessagingParams, sender: ContractAddress,
        ) -> MessagingFee {
            MessagingFee { native_fee: self.native_fee.read(), lz_token_fee: 0 }
        }

        fn set_delegate(ref self: ContractState, delegate: ContractAddress) {}
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockEndpoint<ContractState> {
        fn set_fee(ref self: ContractState, native_fee: u256) {
            self.native_fee.write(native_fee);
        }
        fn last_dst_eid(self: @ContractState) -> u32 {
            self.last_dst_eid.read()
        }
        fn last_message(self: @ContractState) -> ByteArray {
            self.last_message.read()
        }
        fn last_options(self: @ContractState) -> ByteArray {
            self.last_options.read()
        }
        fn last_refund_address(self: @ContractState) -> ContractAddress {
            self.last_refund_address.read()
        }
        fn send_count(self: @ContractState) -> u32 {
            self.send_count.read()
        }
        fn deliver(
            ref self: ContractState,
            receiver: ContractAddress,
            src_eid: u32,
            sender: Bytes32,
            message: ByteArray,
        ) {
            let nonce = self.nonce.read() + 1;
            self.nonce.write(nonce);
            ILayerZeroReceiverDispatcher { contract_address: receiver }
                .lz_receive(
                    Origin { src_eid, sender, nonce },
                    Bytes32 { value: nonce.into() },
                    message,
                    get_contract_address(),
                    Default::default(),
                    0,
                );
        }
    }
}

#[starknet::interface]
pub trait IMockERC20<TContractState> {
    fn mint(ref self: TContractState, to: ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockERC20 {
    use openzeppelin_token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;
    use super::IMockERC20;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.erc20.initializer("Mock", "MOCK");
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockERC20<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.erc20.mint(to, amount);
        }
    }
}

#[starknet::interface]
pub trait IMockLzReceiver<TContractState> {
    fn last_src_eid(self: @TContractState) -> u32;
    fn last_sender(self: @TContractState) -> crate::lz::Bytes32;
    fn last_message(self: @TContractState) -> ByteArray;
    fn received(self: @TContractState) -> u32;
}

/// A LayerZero receiver that only records what it was handed — enough to see
/// what an endpoint (or the relay endpoint) delivered.
#[starknet::contract]
pub mod MockLzReceiver {
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use crate::lz::{Bytes32, ILayerZeroReceiver, Origin};
    use super::IMockLzReceiver;

    #[storage]
    struct Storage {
        last_src_eid: u32,
        last_sender: Bytes32,
        last_message: ByteArray,
        received: u32,
    }

    #[abi(embed_v0)]
    impl ReceiverImpl of ILayerZeroReceiver<ContractState> {
        fn lz_receive(
            ref self: ContractState,
            origin: Origin,
            guid: Bytes32,
            message: ByteArray,
            executor: ContractAddress,
            extra_data: ByteArray,
            value: u256,
        ) {
            self.last_src_eid.write(origin.src_eid);
            self.last_sender.write(origin.sender);
            self.last_message.write(message);
            self.received.write(self.received.read() + 1);
        }
        fn allow_initialize_path(self: @ContractState, origin: Origin) -> bool {
            true
        }
        fn next_nonce(self: @ContractState, src_eid: u32, sender: Bytes32) -> u64 {
            0
        }
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockLzReceiver<ContractState> {
        fn last_src_eid(self: @ContractState) -> u32 {
            self.last_src_eid.read()
        }
        fn last_sender(self: @ContractState) -> Bytes32 {
            self.last_sender.read()
        }
        fn last_message(self: @ContractState) -> ByteArray {
            self.last_message.read()
        }
        fn received(self: @ContractState) -> u32 {
            self.received.read()
        }
    }
}

#[starknet::interface]
pub trait IMockFiatToken<TContractState> {
    fn set_paused(ref self: TContractState, paused: bool);
    fn set_blocklisted(ref self: TContractState, account: ContractAddress, blocklisted: bool);
}

/// Circle's FiatToken as HyperVeil reads it (Starknet USDC, Sepolia ABI read
/// 2026-09-19): an ERC-20 with `paused()` and `is_blocklisted(account)`, and
/// `mint` for the CCTP mock. Paused, it refuses every transfer.
#[starknet::contract]
pub mod MockFiatToken {
    use openzeppelin_token::erc20::{DefaultConfig, ERC20Component};
    use starknet::ContractAddress;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use crate::kyc_rules::ICircleFiatToken;
    use super::{IMockERC20, IMockFiatToken};

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        paused: bool,
        blocklisted: Map<ContractAddress, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    impl Hooks of ERC20Component::ERC20HooksTrait<ContractState> {
        fn before_update(
            ref self: ERC20Component::ComponentState<ContractState>,
            from: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) {
            let contract = self.get_contract();
            assert(!contract.paused.read(), 'MOCK_USDC_PAUSED');
        }
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.erc20.initializer("USD Coin", "USDC");
    }

    #[abi(embed_v0)]
    impl MintImpl of IMockERC20<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.erc20.mint(to, amount);
        }
    }

    #[abi(embed_v0)]
    impl CircleImpl of ICircleFiatToken<ContractState> {
        fn paused(self: @ContractState) -> bool {
            self.paused.read()
        }
        fn is_blocklisted(self: @ContractState, account: ContractAddress) -> bool {
            self.blocklisted.read(account)
        }
    }

    #[abi(embed_v0)]
    impl ControlsImpl of IMockFiatToken<ContractState> {
        fn set_paused(ref self: ContractState, paused: bool) {
            self.paused.write(paused);
        }
        fn set_blocklisted(ref self: ContractState, account: ContractAddress, blocklisted: bool) {
            self.blocklisted.write(account, blocklisted);
        }
    }
}

/// What the last `deposit_for_burn_with_hook` was called with.
#[derive(Drop, Serde, starknet::Store)]
pub struct BurnCall {
    pub caller: ContractAddress,
    pub amount: u256,
    pub destination_domain: u32,
    pub mint_recipient: u256,
    pub burn_token: ContractAddress,
    pub destination_caller: u256,
    pub max_fee: u256,
    pub min_finality_threshold: u32,
}

#[starknet::interface]
pub trait IMockTokenMessenger<TContractState> {
    fn last_burn(self: @TContractState) -> BurnCall;
    fn last_hook_data(self: @TContractState) -> ByteArray;
    fn burn_count(self: @TContractState) -> u32;
}

#[starknet::contract]
pub mod MockTokenMessenger {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::interfaces::{IERC20Dispatcher, IERC20DispatcherTrait, ITokenMessengerMinterV2};
    use super::{BurnCall, IMockTokenMessenger};

    #[storage]
    struct Storage {
        last_burn: BurnCall,
        last_hook_data: ByteArray,
        burn_count: u32,
    }

    #[abi(embed_v0)]
    impl MessengerImpl of ITokenMessengerMinterV2<ContractState> {
        fn deposit_for_burn_with_hook(
            ref self: ContractState,
            amount: u256,
            destination_domain: u32,
            mint_recipient: u256,
            burn_token: ContractAddress,
            destination_caller: u256,
            max_fee: u256,
            min_finality_threshold: u32,
            hook_data: ByteArray,
        ) {
            let caller = get_caller_address();
            assert(hook_data.len() != 0, 'MOCK_EMPTY_HOOK');
            // Pulled and held here: "burned" as far as the caller can tell.
            IERC20Dispatcher { contract_address: burn_token }
                .transfer_from(caller, get_contract_address(), amount);
            self
                .last_burn
                .write(
                    BurnCall {
                        caller,
                        amount,
                        destination_domain,
                        mint_recipient,
                        burn_token,
                        destination_caller,
                        max_fee,
                        min_finality_threshold,
                    },
                );
            self.last_hook_data.write(hook_data);
            self.burn_count.write(self.burn_count.read() + 1);
        }
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockTokenMessenger<ContractState> {
        fn last_burn(self: @ContractState) -> BurnCall {
            self.last_burn.read()
        }
        fn last_hook_data(self: @ContractState) -> ByteArray {
            self.last_hook_data.read()
        }
        fn burn_count(self: @ContractState) -> u32 {
            self.burn_count.read()
        }
    }
}

#[starknet::contract]
pub mod MockMessageTransmitter {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use crate::bytes::read_be;
    use crate::interfaces::IMessageTransmitterV2;
    use super::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};

    #[storage]
    struct Storage {
        usdc: ContractAddress,
        used: Map<felt252, bool>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, usdc: ContractAddress) {
        self.usdc.write(usdc);
    }

    #[abi(embed_v0)]
    impl TransmitterImpl of IMessageTransmitterV2<ContractState> {
        fn receive_message(
            ref self: ContractState, message: ByteArray, attestation: ByteArray,
        ) -> bool {
            assert(attestation == "ATTESTED", 'MOCK_BAD_ATTESTATION');
            let caller_word: u256 = {
                let f: felt252 = get_caller_address().into();
                f.into()
            };
            let destination_caller = read_be(@message, 108, 32);
            assert(
                destination_caller == 0 || destination_caller == caller_word,
                'MOCK_WRONG_DESTINATION_CALLER',
            );
            let mut words: Array<felt252> = array![];
            let mut i = 0;
            while i != message.len() {
                words.append(message.at(i).unwrap().into());
                i += 1;
            }
            let key = poseidon_hash_span(words.span());
            assert(!self.used.read(key), 'MOCK_NONCE_USED');
            self.used.write(key, true);

            let recipient: felt252 = read_be(@message, 148 + 36, 32).try_into().unwrap();
            let recipient: ContractAddress = recipient.try_into().unwrap();
            assert(!recipient.is_zero(), 'MOCK_ZERO_RECIPIENT');
            let amount = read_be(@message, 148 + 68, 32);
            let fee_executed = read_be(@message, 148 + 164, 32);
            IMockERC20Dispatcher { contract_address: self.usdc.read() }
                .mint(recipient, amount - fee_executed);
            true
        }
    }
}

#[starknet::interface]
pub trait IMockStrk20Pool<TContractState> {
    /// One STRK20 transaction: `withdrawals` pay `target` from this pool's
    /// balance, `open_notes` are created, then Invoke calls `target`'s
    /// `privacy_invoke(calldata)` and applies the returned deposits.
    fn invoke(
        ref self: TContractState,
        target: ContractAddress,
        withdrawals: Array<(ContractAddress, u256)>,
        open_notes: Array<(felt252, ContractAddress)>,
        calldata: Array<felt252>,
    );
    fn note_amount(self: @TContractState, note_id: felt252) -> u128;
}

#[starknet::contract]
pub mod MockStrk20Pool {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_contract_address};
    use crate::interfaces::{IERC20Dispatcher, IERC20DispatcherTrait, OpenNoteDeposit};
    use super::IMockStrk20Pool;

    #[storage]
    struct Storage {
        note_token: Map<felt252, ContractAddress>,
        note_amount: Map<felt252, u128>,
    }

    #[abi(embed_v0)]
    impl PoolImpl of IMockStrk20Pool<ContractState> {
        fn invoke(
            ref self: ContractState,
            target: ContractAddress,
            withdrawals: Array<(ContractAddress, u256)>,
            open_notes: Array<(felt252, ContractAddress)>,
            calldata: Array<felt252>,
        ) {
            for (token, amount) in withdrawals {
                IERC20Dispatcher { contract_address: token }.transfer(target, amount);
            }
            for (note_id, token) in open_notes.span() {
                assert(self.note_token.read(*note_id).is_zero(), 'MOCK_NOTE_EXISTS');
                self.note_token.write(*note_id, *token);
            }
            let mut ret = call_contract_syscall(target, selector!("privacy_invoke"), calldata.span())
                .unwrap_syscall();
            let deposits: Span<OpenNoteDeposit> = Serde::deserialize(ref ret)
                .expect('INVALID_INVOKE_RETURN_DATA');
            let mut filled: u32 = 0;
            for deposit in deposits {
                let OpenNoteDeposit { note_id, token, amount } = *deposit;
                assert(amount != 0, 'ZERO_AMOUNT');
                assert(self.note_token.read(note_id) == token, 'TOKEN_MISMATCH');
                assert(self.note_amount.read(note_id) == 0, 'NOTE_ALREADY_DEPOSITED');
                self.note_amount.write(note_id, amount);
                IERC20Dispatcher { contract_address: token }
                    .transfer_from(target, get_contract_address(), amount.into());
                filled += 1;
            }
            assert(filled == open_notes.len(), 'UNDEPOSITED_OPEN_NOTES');
        }

        fn note_amount(self: @ContractState, note_id: felt252) -> u128 {
            self.note_amount.read(note_id)
        }
    }
}
