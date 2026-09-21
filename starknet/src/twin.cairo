// A HyperVeil twin: the Starknet-side claim on one HyperCore spot token that
// the omnibus holds on Hyperliquid (HIP-1 tokens and HyperCore USDC alike).
//
// Supply. Only the gateway mints and burns, and it does so only on the
// omnibus's word (a CREDIT for a deposit, a FILL for an execution) or when a
// twin goes back out (routing an order's escrow, an exit). The omnibus refuses
// any report that would leave its real HyperCore balance below what the twins
// claim, so a twin is never minted out of nothing.
//
// Units. One twin unit is one HyperCore wei of the token (`weiDecimals`), so
// `decimals()` equals the token's `weiDecimals` and no amount is ever rescaled
// between chains.
//
// Holding. An allowlisted ERC-20 in the Veil pool's sense (token kind 2): every
// movement requires the token unpaused and BOTH sides whitelisted in the
// permission manager (KYC'd), exactly like Spiko's fund tokens. Mint and burn
// are gateway operations and skip the sender side; a mint still requires a
// whitelisted recipient, and a burn only takes from the gateway's own custody.

#[starknet::interface]
pub trait IHyperVeilTwin<TContractState> {
    fn mint(ref self: TContractState, to: starknet::ContractAddress, amount: u256);
    /// Gateway only, and only from the gateway's own balance.
    fn burn(ref self: TContractState, from: starknet::ContractAddress, amount: u256);
    fn is_paused(self: @TContractState) -> bool;
    fn pause(ref self: TContractState);
    fn unpause(ref self: TContractState);
    fn set_gateway(ref self: TContractState, gateway: starknet::ContractAddress);
    fn gateway(self: @TContractState) -> starknet::ContractAddress;
    fn permission_manager(self: @TContractState) -> starknet::ContractAddress;
    /// The HyperCore token index this twin mirrors.
    fn hl_token(self: @TContractState) -> u64;
    fn owner(self: @TContractState) -> starknet::ContractAddress;
    fn transfer_ownership(ref self: TContractState, new_owner: starknet::ContractAddress);
}

#[starknet::interface]
pub trait IERC20Metadata<TContractState> {
    fn name(self: @TContractState) -> ByteArray;
    fn symbol(self: @TContractState) -> ByteArray;
    fn decimals(self: @TContractState) -> u8;
}

#[starknet::contract]
pub mod HyperVeilTwin {
    use core::num::traits::Zero;
    use openzeppelin_token::erc20::ERC20Component;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use crate::interfaces::{IVeilPermissionManagerDispatcher, IVeilPermissionManagerDispatcherTrait};
    use crate::permission_manager::WHITELISTED_ROLE;
    use super::{IERC20Metadata, IHyperVeilTwin};

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    #[abi(embed_v0)]
    impl ERC20CamelOnlyImpl = ERC20Component::ERC20CamelOnlyImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    // Decimals are per deployment (they follow the HyperCore token), so the
    // component's compile-time metadata impl is not embedded; this constant is
    // only there to satisfy the component and is never read.
    impl ERC20ConfigImpl of ERC20Component::ImmutableConfig {
        const DECIMALS: u8 = 18;
    }

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        decimals: u8,
        hl_token: u64,
        owner: ContractAddress,
        gateway: ContractAddress,
        permission_manager: ContractAddress,
        paused: bool,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
        PausedSet: PausedSet,
        GatewaySet: GatewaySet,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[derive(Drop, starknet::Event)]
    struct PausedSet {
        paused: bool,
    }

    #[derive(Drop, starknet::Event)]
    struct GatewaySet {
        gateway: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct OwnershipTransferred {
        previous_owner: ContractAddress,
        new_owner: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: ByteArray,
        symbol: ByteArray,
        decimals: u8,
        hl_token: u64,
        owner: ContractAddress,
        permission_manager: ContractAddress,
        gateway: ContractAddress,
    ) {
        assert(!owner.is_zero(), 'ZERO_OWNER');
        assert(!permission_manager.is_zero(), 'ZERO_PERMISSION_MANAGER');
        self.erc20.initializer(name, symbol);
        self.decimals.write(decimals);
        self.hl_token.write(hl_token);
        self.owner.write(owner);
        self.permission_manager.write(permission_manager);
        self.gateway.write(gateway);
    }

    fn is_whitelisted(self: @ContractState, account: ContractAddress) -> bool {
        IVeilPermissionManagerDispatcher { contract_address: self.permission_manager.read() }
            .has_role(WHITELISTED_ROLE, account)
    }

    // Holder-to-holder movements only; mint and burn are gated where they are
    // called, so the hook sees them already authorised.
    impl HooksImpl of ERC20Component::ERC20HooksTrait<ContractState> {
        fn before_update(
            ref self: ERC20Component::ComponentState<ContractState>,
            from: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) {
            if from.is_zero() || recipient.is_zero() {
                return;
            }
            let contract = self.get_contract();
            assert(!contract.paused.read(), 'TWIN_PAUSED');
            assert(is_whitelisted(contract, from), 'FROM_NOT_WHITELISTED');
            assert(is_whitelisted(contract, recipient), 'TO_NOT_WHITELISTED');
        }
    }

    #[abi(embed_v0)]
    impl MetadataImpl of IERC20Metadata<ContractState> {
        fn name(self: @ContractState) -> ByteArray {
            self.erc20.ERC20_name.read()
        }
        fn symbol(self: @ContractState) -> ByteArray {
            self.erc20.ERC20_symbol.read()
        }
        fn decimals(self: @ContractState) -> u8 {
            self.decimals.read()
        }
    }

    #[abi(embed_v0)]
    impl TwinImpl of IHyperVeilTwin<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            assert_gateway(@self);
            assert(is_whitelisted(@self, to), 'TO_NOT_WHITELISTED');
            self.erc20.mint(to, amount);
        }

        fn burn(ref self: ContractState, from: ContractAddress, amount: u256) {
            let gateway = assert_gateway(@self);
            assert(from == gateway, 'BURN_NOT_OWN_BALANCE');
            self.erc20.burn(from, amount);
        }

        fn is_paused(self: @ContractState) -> bool {
            self.paused.read()
        }

        fn pause(ref self: ContractState) {
            assert_owner(@self);
            self.paused.write(true);
            self.emit(PausedSet { paused: true });
        }

        fn unpause(ref self: ContractState) {
            assert_owner(@self);
            self.paused.write(false);
            self.emit(PausedSet { paused: false });
        }

        fn set_gateway(ref self: ContractState, gateway: ContractAddress) {
            assert_owner(@self);
            self.gateway.write(gateway);
            self.emit(GatewaySet { gateway });
        }

        fn gateway(self: @ContractState) -> ContractAddress {
            self.gateway.read()
        }

        fn permission_manager(self: @ContractState) -> ContractAddress {
            self.permission_manager.read()
        }

        fn hl_token(self: @ContractState) -> u64 {
            self.hl_token.read()
        }

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            assert_owner(@self);
            assert(!new_owner.is_zero(), 'ZERO_OWNER');
            let previous_owner = self.owner.read();
            self.owner.write(new_owner);
            self.emit(OwnershipTransferred { previous_owner, new_owner });
        }
    }

    fn assert_owner(self: @ContractState) {
        assert(get_caller_address() == self.owner.read(), 'ONLY_OWNER');
    }

    fn assert_gateway(self: @ContractState) -> ContractAddress {
        let gateway = self.gateway.read();
        assert(!gateway.is_zero(), 'GATEWAY_UNSET');
        assert(get_caller_address() == gateway, 'ONLY_GATEWAY');
        gateway
    }
}
