// HyperVeilKycRules — how real USDC and STRK sit in the HyperVeil Veil pool.
//
// The pool gates every token it carries. HyperVeil's twins are allowlisted
// ERC-20s (pool token kind 2), whose own transfer hook checks the KYC list. Real
// USDC and STRK have no such hook, and the pool's kind-2 path also asks the
// token itself `is_paused()`, which neither answers (Starknet USDC is Circle's
// FiatToken: `paused()`; STRK has no pause). So they are registered as RULES
// tokens (kind 3), and this contract answers the pool's `ITransferRules`
// questions for one of them:
//
//   * HyperVeil's policy: a holder must have `WHITELISTED_ROLE` in the
//     HyperVeil permission manager — the same KYC list as the twins;
//   * the token's own rules, when it has any. For Circle's FiatToken (`circle`
//     set at deployment): its pause, and its blocklist as a freeze. Nothing
//     else: no locks, no whole-balance rule, no investor cap, no minimum.
//
// Restated from `veil::interfaces::IVeilERC3643::ITransferRules` (names,
// argument order and types must match; the tests run against the real pool).

use starknet::ContractAddress;

#[starknet::interface]
pub trait ITransferRules<TContractState> {
    fn can_hold(self: @TContractState, account: ContractAddress) -> bool;
    fn is_frozen(self: @TContractState, account: ContractAddress) -> bool;
    fn is_paused(self: @TContractState) -> bool;
    fn transfers_enabled(self: @TContractState) -> bool;
    fn can_transfer(
        self: @TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    ) -> bool;
    fn requires_full_balance(
        self: @TContractState, from: ContractAddress, to: ContractAddress,
    ) -> bool;
    fn locked_amount(self: @TContractState, account: ContractAddress) -> u256;
    fn new_investor_capped(
        self: @TContractState, from: ContractAddress, to: ContractAddress,
    ) -> bool;
    fn min_residual(
        self: @TContractState, from: ContractAddress, to: ContractAddress,
    ) -> (u256, bool);
}

#[starknet::interface]
pub trait IHyperVeilKycRules<TContractState> {
    fn token(self: @TContractState) -> ContractAddress;
    fn permission_manager(self: @TContractState) -> ContractAddress;
    /// Whether the token's own pause and blocklist (Circle FiatToken) are
    /// mirrored.
    fn circle(self: @TContractState) -> bool;
}

/// Circle's FiatToken on Starknet (`circlefin/stablecoin-starknet`): the two
/// token rules this contract mirrors.
#[starknet::interface]
pub trait ICircleFiatToken<TContractState> {
    fn paused(self: @TContractState) -> bool;
    fn is_blocklisted(self: @TContractState, account: ContractAddress) -> bool;
}

#[starknet::contract]
pub mod HyperVeilKycRules {
    use core::num::traits::Zero;
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use crate::interfaces::{IVeilPermissionManagerDispatcher, IVeilPermissionManagerDispatcherTrait};
    use crate::permission_manager::WHITELISTED_ROLE;
    use super::{
        ICircleFiatTokenDispatcher, ICircleFiatTokenDispatcherTrait, IHyperVeilKycRules,
        ITransferRules,
    };

    #[storage]
    struct Storage {
        token: ContractAddress,
        permission_manager: ContractAddress,
        circle: bool,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        token: ContractAddress,
        permission_manager: ContractAddress,
        circle: bool,
    ) {
        assert(!token.is_zero(), 'ZERO_TOKEN');
        assert(!permission_manager.is_zero(), 'ZERO_PERMISSION_MANAGER');
        self.token.write(token);
        self.permission_manager.write(permission_manager);
        self.circle.write(circle);
    }

    #[abi(embed_v0)]
    impl TransferRulesImpl of ITransferRules<ContractState> {
        fn can_hold(self: @ContractState, account: ContractAddress) -> bool {
            self.whitelisted(account) && !self.blocklisted(account)
        }

        fn is_frozen(self: @ContractState, account: ContractAddress) -> bool {
            self.blocklisted(account)
        }

        fn is_paused(self: @ContractState) -> bool {
            if !self.circle.read() {
                return false;
            }
            ICircleFiatTokenDispatcher { contract_address: self.token.read() }.paused()
        }

        fn transfers_enabled(self: @ContractState) -> bool {
            true
        }

        fn can_transfer(
            self: @ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) -> bool {
            !self.is_paused() && self.can_hold(from) && self.can_hold(to)
        }

        fn requires_full_balance(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> bool {
            false
        }

        fn locked_amount(self: @ContractState, account: ContractAddress) -> u256 {
            0
        }

        fn new_investor_capped(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> bool {
            false
        }

        fn min_residual(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> (u256, bool) {
            (0, false)
        }
    }

    #[abi(embed_v0)]
    impl KycRulesImpl of IHyperVeilKycRules<ContractState> {
        fn token(self: @ContractState) -> ContractAddress {
            self.token.read()
        }
        fn permission_manager(self: @ContractState) -> ContractAddress {
            self.permission_manager.read()
        }
        fn circle(self: @ContractState) -> bool {
            self.circle.read()
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn whitelisted(self: @ContractState, account: ContractAddress) -> bool {
            IVeilPermissionManagerDispatcher { contract_address: self.permission_manager.read() }
                .has_role(WHITELISTED_ROLE, account)
        }

        fn blocklisted(self: @ContractState, account: ContractAddress) -> bool {
            if !self.circle.read() {
                return false;
            }
            ICircleFiatTokenDispatcher { contract_address: self.token.read() }
                .is_blocklisted(account)
        }
    }
}
