// HyperVeil's KYC allowlist: who may hold a HyperVeil twin.
//
// Every twin is an allowlisted ERC-20 (Veil pool token kind 2): its transfer
// hook, and the pool's proofs for movements inside the pool, require
// `WHITELISTED_ROLE` here for every holder. The role is granted by accounts
// holding `WHITELISTER_ROLE` — the KYC operator. The KYC provider integration
// lands later and will call `whitelist` / `unwhitelist`; nothing here depends
// on which provider it is.
//
// OpenZeppelin AccessControl, the same shape as Spiko's permission manager, so
// the pool reads it through the one `has_role(role, account)` it already knows.

pub const WHITELISTED_ROLE: felt252 = selector!("WHITELISTED_ROLE");
pub const WHITELISTER_ROLE: felt252 = selector!("WHITELISTER_ROLE");

#[starknet::interface]
pub trait IHyperVeilPermissionManager<TContractState> {
    /// Whitelister only. Grants `WHITELISTED_ROLE` to every account.
    fn whitelist(ref self: TContractState, accounts: Array<starknet::ContractAddress>);
    /// Whitelister only. Revokes `WHITELISTED_ROLE` from every account.
    fn unwhitelist(ref self: TContractState, accounts: Array<starknet::ContractAddress>);
    fn is_whitelisted(self: @TContractState, account: starknet::ContractAddress) -> bool;
}

#[starknet::contract]
pub mod HyperVeilPermissionManager {
    use core::num::traits::Zero;
    use openzeppelin_access::accesscontrol::{AccessControlComponent, DEFAULT_ADMIN_ROLE};
    use openzeppelin_introspection::src5::SRC5Component;
    use starknet::ContractAddress;
    use super::{IHyperVeilPermissionManager, WHITELISTED_ROLE, WHITELISTER_ROLE};

    component!(path: AccessControlComponent, storage: access_control, event: AccessControlEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    #[abi(embed_v0)]
    impl AccessControlImpl =
        AccessControlComponent::AccessControlImpl<ContractState>;
    #[abi(embed_v0)]
    impl SRC5Impl = SRC5Component::SRC5Impl<ContractState>;
    impl AccessControlInternalImpl = AccessControlComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        access_control: AccessControlComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        AccessControlEvent: AccessControlComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
    }

    /// `admin` manages roles; `whitelister` (optional) runs KYC from day one.
    #[constructor]
    fn constructor(ref self: ContractState, admin: ContractAddress, whitelister: ContractAddress) {
        assert(!admin.is_zero(), 'ZERO_ADMIN');
        self.access_control.initializer();
        self.access_control._grant_role(DEFAULT_ADMIN_ROLE, admin);
        self.access_control.set_role_admin(WHITELISTED_ROLE, WHITELISTER_ROLE);
        if !whitelister.is_zero() {
            self.access_control._grant_role(WHITELISTER_ROLE, whitelister);
        }
    }

    #[abi(embed_v0)]
    impl PermissionManagerImpl of IHyperVeilPermissionManager<ContractState> {
        fn whitelist(ref self: ContractState, accounts: Array<ContractAddress>) {
            self.access_control.assert_only_role(WHITELISTER_ROLE);
            for account in accounts {
                self.access_control._grant_role(WHITELISTED_ROLE, account);
            }
        }

        fn unwhitelist(ref self: ContractState, accounts: Array<ContractAddress>) {
            self.access_control.assert_only_role(WHITELISTER_ROLE);
            for account in accounts {
                self.access_control._revoke_role(WHITELISTED_ROLE, account);
            }
        }

        fn is_whitelisted(self: @ContractState, account: ContractAddress) -> bool {
            AccessControlImpl::has_role(self, WHITELISTED_ROLE, account)
        }
    }
}
