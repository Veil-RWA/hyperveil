// HyperVeilExitVault — how USDC comes back from Hyperliquid into the Veil pool.
//
// 1. The gateway registers an exit, naming the note it pays: the user's empty
//    real-USDC open note in the HyperVeil Veil pool (created beforehand with
//    `create_open_note`). The note is checked here, before anything leaves
//    Starknet, and no other exit may name it.
// 2. The omnibus burns the USDC on HyperEVM through CCTP with this contract as
//    both mint recipient and destination caller, and the exit id as hook data.
//    `receive_exit` relays Circle's attested message: only this contract can,
//    and it binds the USDC that arrives to that exit.
// 3. In the same call the vault fills the named open note (it is an allowed
//    adapter of the pool). Observers see an open note filled by the vault;
//    only its owner can tell it is theirs. If the pool refuses the fill (say it
//    is paused), the USDC stays here, owed to that exit alone, and anyone may
//    retry the delivery later.
//
// Fixed configuration, no admin, nothing to rescue: every unit here is owed to
// exactly one registered exit.

/// Circle CCTP domain the exits come from (HyperEVM).
pub const HYPEREVM_DOMAIN: u32 = 19;

pub const EXIT_NONE: u8 = 0;
pub const EXIT_REGISTERED: u8 = 1;
/// The USDC arrived but the note has not been filled yet (quarantined).
pub const EXIT_FUNDED: u8 = 2;
pub const EXIT_DELIVERED: u8 = 3;

#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct ExitRecord {
    /// The real-USDC open note in the Veil pool this exit fills.
    pub note_id: felt252,
    /// What the omnibus was asked to send (USDC, 6 dp).
    pub expected: u128,
    /// What CCTP actually minted here (after any CCTP fee).
    pub funded: u128,
    pub status: u8,
}

#[starknet::interface]
pub trait IHyperVeilExitVault<TContractState> {
    /// Gateway only. `note_id` must be an empty real-USDC open note of the
    /// gateway's pool that no other exit names.
    fn register_exit(
        ref self: TContractState, exit_id: felt252, note_id: felt252, amount_usdc6: u128,
    );
    /// Permissionless relay of Circle's attested burn message for one exit.
    /// Fills the exit's note; returns the exit id.
    fn receive_exit(
        ref self: TContractState, message: ByteArray, attestation: ByteArray,
    ) -> felt252;
    /// Permissionless. Fills the note of an exit whose delivery was refused.
    fn retry_delivery(ref self: TContractState, exit_id: felt252);
    fn exit_of(self: @TContractState, exit_id: felt252) -> ExitRecord;
    /// The exit that names `note_id`, or 0.
    fn exit_of_note(self: @TContractState, note_id: felt252) -> felt252;
    fn gateway(self: @TContractState) -> starknet::ContractAddress;
    fn usdc(self: @TContractState) -> starknet::ContractAddress;
}

#[starknet::contract]
pub mod HyperVeilExitVault {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address};
    use crate::bytes::read_be;
    use crate::gateway::{IHyperVeilGatewayDispatcher, IHyperVeilGatewayDispatcherTrait};
    use crate::interfaces::{
        IERC20Dispatcher, IERC20DispatcherTrait, IMessageTransmitterV2Dispatcher,
        IMessageTransmitterV2DispatcherTrait, IVeilPoolDispatcher, IVeilPoolDispatcherTrait,
    };
    use super::{
        EXIT_DELIVERED, EXIT_FUNDED, EXIT_NONE, EXIT_REGISTERED, ExitRecord, HYPEREVM_DOMAIN,
        IHyperVeilExitVault,
    };

    // CCTP V2 message layout (circlefin/starknet-cctp `message_v2` and
    // `burn_message_v2`; identical on every chain).
    const SOURCE_DOMAIN_INDEX: u32 = 4;
    const DESTINATION_CALLER_INDEX: u32 = 108;
    const MESSAGE_BODY_INDEX: u32 = 148;
    const MINT_RECIPIENT_INDEX: u32 = 148 + 36;
    const MESSAGE_SENDER_INDEX: u32 = 148 + 100;
    const HOOK_DATA_INDEX: u32 = 148 + 228;
    // An empty open note in the pool: salt 1 in the high 128 bits, amount 0.
    const EMPTY_OPEN_NOTE: felt252 = 0x100000000000000000000000000000000;

    #[storage]
    struct Storage {
        gateway: ContractAddress,
        usdc: ContractAddress,
        message_transmitter: ContractAddress,
        /// The omnibus's HyperEVM address, as CCTP's 32-byte word.
        omnibus: u256,
        exits: Map<felt252, ExitRecord>,
        note_exit: Map<felt252, felt252>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        ExitRegistered: ExitRegistered,
        ExitFunded: ExitFunded,
        ExitDelivered: ExitDelivered,
        DeliveryQuarantined: DeliveryQuarantined,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ExitRegistered {
        #[key]
        pub exit_id: felt252,
        pub note_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ExitFunded {
        #[key]
        pub exit_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ExitDelivered {
        #[key]
        pub exit_id: felt252,
        pub note_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DeliveryQuarantined {
        #[key]
        pub exit_id: felt252,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        gateway: ContractAddress,
        usdc: ContractAddress,
        message_transmitter: ContractAddress,
        omnibus: u256,
    ) {
        assert(!gateway.is_zero(), 'ZERO_GATEWAY');
        assert(!usdc.is_zero(), 'ZERO_USDC');
        assert(!message_transmitter.is_zero(), 'ZERO_TRANSMITTER');
        assert(omnibus != 0 && omnibus.high < 0x100000000, 'BAD_OMNIBUS');
        self.gateway.write(gateway);
        self.usdc.write(usdc);
        self.message_transmitter.write(message_transmitter);
        self.omnibus.write(omnibus);
    }

    #[abi(embed_v0)]
    impl ExitVaultImpl of IHyperVeilExitVault<ContractState> {
        fn register_exit(
            ref self: ContractState, exit_id: felt252, note_id: felt252, amount_usdc6: u128,
        ) {
            assert(get_caller_address() == self.gateway.read(), 'ONLY_GATEWAY');
            assert(amount_usdc6 != 0, 'ZERO_AMOUNT');
            assert(note_id != 0, 'HV_NO_NOTE');
            assert(self.exits.read(exit_id).status == EXIT_NONE, 'EXIT_EXISTS');
            // One exit per note: the fill is one-shot, so a second exit naming
            // the same note could never be delivered.
            assert(self.note_exit.read(note_id) == 0, 'HV_NOTE_CLAIMED');
            let pool = IVeilPoolDispatcher { contract_address: self.pool() };
            assert(pool.get_open_note(note_id).token == self.usdc.read(), 'HV_NOT_USDC_NOTE');
            assert(
                *pool.get_notes_batch(array![note_id]).at(0).encrypted_amount == EMPTY_OPEN_NOTE,
                'HV_NOTE_NOT_EMPTY',
            );
            self
                .exits
                .write(
                    exit_id,
                    ExitRecord { note_id, expected: amount_usdc6, funded: 0, status: EXIT_REGISTERED },
                );
            self.note_exit.write(note_id, exit_id);
            self.emit(ExitRegistered { exit_id, note_id, amount: amount_usdc6 });
        }

        fn receive_exit(
            ref self: ContractState, message: ByteArray, attestation: ByteArray,
        ) -> felt252 {
            let this = get_contract_address();
            let this_word: u256 = {
                let f: felt252 = this.into();
                f.into()
            };
            // Only a burn the omnibus made, from HyperEVM, minting here, that
            // only this contract may relay, and naming one exit.
            assert(message.len() == HOOK_DATA_INDEX + 32, 'BAD_EXIT_MESSAGE');
            let source: u32 = read_be(@message, SOURCE_DOMAIN_INDEX, 4).low.try_into().unwrap();
            assert(source == HYPEREVM_DOMAIN, 'WRONG_SOURCE_DOMAIN');
            assert(read_be(@message, DESTINATION_CALLER_INDEX, 32) == this_word, 'NOT_OUR_RELAY');
            assert(read_be(@message, MINT_RECIPIENT_INDEX, 32) == this_word, 'NOT_MINTED_HERE');
            assert(
                read_be(@message, MESSAGE_SENDER_INDEX, 32) == self.omnibus.read(),
                'NOT_FROM_OMNIBUS',
            );
            let exit_id: felt252 = read_be(@message, HOOK_DATA_INDEX, 32)
                .try_into()
                .expect('EXIT_ID_NOT_FELT');
            let mut exit = self.exits.read(exit_id);
            assert(exit.status == EXIT_REGISTERED, 'EXIT_NOT_AWAITING_FUNDS');

            let usdc = IERC20Dispatcher { contract_address: self.usdc.read() };
            let before = usdc.balance_of(this);
            let ok = IMessageTransmitterV2Dispatcher {
                contract_address: self.message_transmitter.read(),
            }
                .receive_message(message, attestation);
            assert(ok, 'CCTP_RECEIVE_FAILED');
            let received = usdc.balance_of(this) - before;
            assert(received != 0, 'NOTHING_MINTED');
            assert(received <= exit.expected.into(), 'MINTED_TOO_MUCH');

            exit.funded = received.low;
            exit.status = EXIT_FUNDED;
            self.exits.write(exit_id, exit);
            self.emit(ExitFunded { exit_id, amount: received.low });
            // Never revert here once the USDC has arrived: a refused fill keeps
            // the exit FUNDED (quarantined) for `retry_delivery`.
            if !self.deliver(exit_id, false) {
                self.emit(DeliveryQuarantined { exit_id });
            }
            exit_id
        }

        fn retry_delivery(ref self: ContractState, exit_id: felt252) {
            assert(self.exits.read(exit_id).status == EXIT_FUNDED, 'EXIT_NOT_FUNDED');
            self.deliver(exit_id, true);
        }

        fn exit_of(self: @ContractState, exit_id: felt252) -> ExitRecord {
            self.exits.read(exit_id)
        }
        fn exit_of_note(self: @ContractState, note_id: felt252) -> felt252 {
            self.note_exit.read(note_id)
        }
        fn gateway(self: @ContractState) -> ContractAddress {
            self.gateway.read()
        }
        fn usdc(self: @ContractState) -> ContractAddress {
            self.usdc.read()
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn pool(self: @ContractState) -> ContractAddress {
            IHyperVeilGatewayDispatcher { contract_address: self.gateway.read() }.pool()
        }

        // Approve the pool, let it pull the funded amount into the note, and
        // hold no allowance afterwards. With `must_succeed` false a refusing
        // pool is survived and the exit stays FUNDED.
        fn deliver(ref self: ContractState, exit_id: felt252, must_succeed: bool) -> bool {
            let mut exit = self.exits.read(exit_id);
            let pool = self.pool();
            let this = get_contract_address();
            let usdc = IERC20Dispatcher { contract_address: self.usdc.read() };
            let before = usdc.balance_of(this);
            usdc.approve(pool, exit.funded.into());
            let mut call_data: Array<felt252> = array![];
            exit.note_id.serialize(ref call_data);
            usdc.contract_address.serialize(ref call_data);
            exit.funded.serialize(ref call_data);
            let outcome = call_contract_syscall(pool, selector!("fill_open_note"), call_data.span());
            let taken = usdc.balance_of(this) == before - exit.funded.into();
            if must_succeed {
                outcome.unwrap_syscall();
                assert(taken, 'HV_POOL_TOOK_NOTHING');
            } else if !(outcome.is_ok() && taken) {
                usdc.approve(pool, 0);
                return false;
            }
            exit.status = EXIT_DELIVERED;
            self.exits.write(exit_id, exit);
            self.emit(ExitDelivered { exit_id, note_id: exit.note_id, amount: exit.funded });
            true
        }
    }
}
