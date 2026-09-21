// The twin's own rules, which are also what the Veil pool enforces inside its
// proofs for a kind-2 token: unpaused, both sides KYC'd, and supply that only
// the gateway moves.

use hyperveil::interfaces::{IERC20Dispatcher, IERC20DispatcherTrait};
use hyperveil::permission_manager::{
    IHyperVeilPermissionManagerDispatcher, IHyperVeilPermissionManagerDispatcherTrait,
};
use hyperveil::twin::{
    IERC20MetadataDispatcher, IERC20MetadataDispatcherTrait, IHyperVeilTwinDispatcher,
    IHyperVeilTwinDispatcherTrait,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;

fn admin() -> ContractAddress { 0xA0.try_into().unwrap() }
fn kyc() -> ContractAddress { 0xA1.try_into().unwrap() }
fn gateway() -> ContractAddress { 0xB0.try_into().unwrap() }
fn alice() -> ContractAddress { 0xC0.try_into().unwrap() }
fn bob() -> ContractAddress { 0xC1.try_into().unwrap() }

fn setup() -> (IHyperVeilTwinDispatcher, IHyperVeilPermissionManagerDispatcher) {
    let pm_class = declare("HyperVeilPermissionManager").unwrap().contract_class();
    let (pm, _) = pm_class.deploy(@array![admin().into(), kyc().into()]).unwrap();
    let mut cd: Array<felt252> = array![];
    let name: ByteArray = "HyperVeil HYPE";
    let symbol: ByteArray = "hvHYPE";
    name.serialize(ref cd);
    symbol.serialize(ref cd);
    8_u8.serialize(ref cd);
    150_u64.serialize(ref cd);
    admin().serialize(ref cd);
    pm.serialize(ref cd);
    gateway().serialize(ref cd);
    let (twin, _) = declare("HyperVeilTwin").unwrap().contract_class().deploy(@cd).unwrap();
    let pm = IHyperVeilPermissionManagerDispatcher { contract_address: pm };
    start_cheat_caller_address(pm.contract_address, kyc());
    pm.whitelist(array![gateway(), alice(), bob()]);
    stop_cheat_caller_address(pm.contract_address);
    (IHyperVeilTwinDispatcher { contract_address: twin }, pm)
}

fn mint(twin: IHyperVeilTwinDispatcher, to: ContractAddress, amount: u256) {
    start_cheat_caller_address(twin.contract_address, gateway());
    twin.mint(to, amount);
    stop_cheat_caller_address(twin.contract_address);
}

fn transfer(twin: IHyperVeilTwinDispatcher, from: ContractAddress, to: ContractAddress) {
    start_cheat_caller_address(twin.contract_address, from);
    IERC20Dispatcher { contract_address: twin.contract_address }.transfer(to, 1);
    stop_cheat_caller_address(twin.contract_address);
}

#[test]
fn decimals_and_token_follow_the_hypercore_token() {
    let (twin, _) = setup();
    let meta = IERC20MetadataDispatcher { contract_address: twin.contract_address };
    assert(meta.decimals() == 8, 'decimals');
    assert(meta.symbol() == "hvHYPE", 'symbol');
    assert(twin.hl_token() == 150, 'hl token');
}

#[test]
fn kyc_holders_move_the_twin() {
    let (twin, _) = setup();
    mint(twin, alice(), 10);
    transfer(twin, alice(), bob());
    assert(
        IERC20Dispatcher { contract_address: twin.contract_address }.balance_of(bob()) == 1,
        'not moved',
    );
}

#[test]
#[should_panic(expected: 'TO_NOT_WHITELISTED')]
fn a_recipient_without_kyc_is_refused() {
    let (twin, _) = setup();
    mint(twin, alice(), 10);
    transfer(twin, alice(), 0xDEAD.try_into().unwrap());
}

#[test]
#[should_panic(expected: 'FROM_NOT_WHITELISTED')]
fn a_holder_whose_kyc_was_revoked_cannot_send() {
    let (twin, pm) = setup();
    mint(twin, alice(), 10);
    start_cheat_caller_address(pm.contract_address, kyc());
    pm.unwhitelist(array![alice()]);
    stop_cheat_caller_address(pm.contract_address);
    transfer(twin, alice(), bob());
}

#[test]
#[should_panic(expected: 'TWIN_PAUSED')]
fn a_paused_twin_does_not_move() {
    let (twin, _) = setup();
    mint(twin, alice(), 10);
    start_cheat_caller_address(twin.contract_address, admin());
    twin.pause();
    stop_cheat_caller_address(twin.contract_address);
    transfer(twin, alice(), bob());
}

#[test]
#[should_panic(expected: 'ONLY_GATEWAY')]
fn only_the_gateway_mints() {
    let (twin, _) = setup();
    start_cheat_caller_address(twin.contract_address, alice());
    twin.mint(alice(), 1);
}

#[test]
#[should_panic(expected: 'TO_NOT_WHITELISTED')]
fn the_gateway_mints_only_to_a_kyc_holder() {
    let (twin, _) = setup();
    mint(twin, 0xDEAD.try_into().unwrap(), 1);
}

#[test]
#[should_panic(expected: 'BURN_NOT_OWN_BALANCE')]
fn the_gateway_burns_only_its_own_custody() {
    let (twin, _) = setup();
    mint(twin, alice(), 10);
    start_cheat_caller_address(twin.contract_address, gateway());
    twin.burn(alice(), 1);
}

#[test]
#[should_panic(expected: 'Caller is missing role')]
fn only_the_kyc_operator_whitelists() {
    let (_, pm) = setup();
    start_cheat_caller_address(pm.contract_address, alice());
    pm.whitelist(array![alice()]);
}
