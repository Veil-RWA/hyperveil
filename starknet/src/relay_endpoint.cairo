// HyperVeilRelayEndpoint — a stand-in for LayerZero's endpoint, for TESTNET.
//
// LayerZero has not enabled the HyperEVM testnet (eid 40362) <-> Starknet
// Sepolia (eid 40500) pathway: the HyperEVM endpoint reports
// `isSupportedEid(40500) = false` and the Starknet endpoint has no library for
// 40362, so no message can cross. This contract stands in its place so the
// rest of HyperVeil can be exercised end to end on testnet.
//
// It changes NOTHING about the gateway, the omnibus or any other contract:
// they take their endpoint's address at deployment and speak the same
// `IEndpointV2` to this one. A mainnet deployment simply points at the real
// endpoint and this contract does not exist there — the testnet-only property
// is structural, not a flag someone can flip.
//
// What it does:
//   * `quote` costs nothing: there is no DVN and no executor to pay.
//   * `send` records the message as an event. The relayer (HyperVeil's keeper)
//     watches for it and delivers it on the other chain.
//   * `deliver` hands an inbound message to a receiver as the endpoint would.
//     RELAYER ONLY — whoever may call it can make the gateway believe anything
//     the omnibus could say, including a credit. That is exactly the trust
//     LayerZero's DVNs remove on mainnet, and why this belongs on testnet only.

use starknet::ContractAddress;
use super::lz::{Bytes32, MessagingFee, MessagingParams, MessageReceipt};

#[starknet::interface]
pub trait IHyperVeilRelayEndpoint<TContractState> {
    /// Relayer only. Delivers `message` to `receiver` as coming from
    /// `sender` on `src_eid`.
    fn deliver(
        ref self: TContractState,
        receiver: ContractAddress,
        src_eid: u32,
        sender: Bytes32,
        message: ByteArray,
    );
    fn set_relayer(ref self: TContractState, relayer: ContractAddress);
    fn relayer(self: @TContractState) -> ContractAddress;
    fn owner(self: @TContractState) -> ContractAddress;
    /// How many messages this endpoint has sent, so a relayer can tell whether
    /// it has seen them all.
    fn sent_count(self: @TContractState) -> u64;
}

#[starknet::contract]
pub mod HyperVeilRelayEndpoint {
    use core::num::traits::Zero;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use crate::lz::{
        Bytes32, IEndpointV2, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait,
        MessageReceipt, MessagingFee, MessagingParams, Origin,
    };
    use super::IHyperVeilRelayEndpoint;

    #[storage]
    struct Storage {
        owner: ContractAddress,
        relayer: ContractAddress,
        nonce: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        RelayOut: RelayOut,
        RelayIn: RelayIn,
        RelayerSet: RelayerSet,
    }

    /// One outbound message, for the relayer to carry. `sender` is the app that
    /// sent it, so the far side can present it as the origin.
    #[derive(Drop, starknet::Event)]
    pub struct RelayOut {
        #[key]
        pub nonce: u64,
        #[key]
        pub sender: ContractAddress,
        pub dst_eid: u32,
        pub receiver: Bytes32,
        pub message: ByteArray,
        pub options: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RelayIn {
        #[key]
        pub receiver: ContractAddress,
        pub src_eid: u32,
        pub sender: Bytes32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RelayerSet {
        pub relayer: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, relayer: ContractAddress) {
        assert(!owner.is_zero(), 'ZERO_OWNER');
        self.owner.write(owner);
        self.relayer.write(relayer);
    }

    #[abi(embed_v0)]
    impl EndpointImpl of IEndpointV2<ContractState> {
        fn send(
            ref self: ContractState, params: MessagingParams, refund_address: ContractAddress,
        ) -> MessageReceipt {
            // Nothing is charged, so nothing is pulled from the sender's
            // allowance and there is nothing to refund.
            let nonce = self.nonce.read() + 1;
            self.nonce.write(nonce);
            self
                .emit(
                    RelayOut {
                        nonce,
                        sender: get_caller_address(),
                        dst_eid: params.dst_eid,
                        receiver: params.receiver,
                        message: params.message,
                        options: params.options,
                    },
                );
            MessageReceipt { guid: Bytes32 { value: nonce.into() }, nonce, payees: array![] }
        }

        fn quote(
            self: @ContractState, params: MessagingParams, sender: ContractAddress,
        ) -> MessagingFee {
            MessagingFee { native_fee: 0, lz_token_fee: 0 }
        }

        fn set_delegate(ref self: ContractState, delegate: ContractAddress) {}
    }

    #[abi(embed_v0)]
    impl RelayImpl of IHyperVeilRelayEndpoint<ContractState> {
        fn deliver(
            ref self: ContractState,
            receiver: ContractAddress,
            src_eid: u32,
            sender: Bytes32,
            message: ByteArray,
        ) {
            assert(get_caller_address() == self.relayer.read(), 'ONLY_RELAYER');
            let nonce = self.nonce.read() + 1;
            self.nonce.write(nonce);
            ILayerZeroReceiverDispatcher { contract_address: receiver }
                .lz_receive(
                    Origin { src_eid, sender, nonce },
                    Bytes32 { value: nonce.into() },
                    message,
                    get_caller_address(),
                    Default::default(),
                    0,
                );
            self.emit(RelayIn { receiver, src_eid, sender });
        }

        fn set_relayer(ref self: ContractState, relayer: ContractAddress) {
            assert(get_caller_address() == self.owner.read(), 'ONLY_OWNER');
            self.relayer.write(relayer);
            self.emit(RelayerSet { relayer });
        }

        fn relayer(self: @ContractState) -> ContractAddress {
            self.relayer.read()
        }

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn sent_count(self: @ContractState) -> u64 {
            self.nonce.read()
        }
    }
}
