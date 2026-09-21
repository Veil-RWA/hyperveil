// The testnet relay endpoint: it stands where LayerZero's endpoint would, so
// the gateway and the omnibus are deployed unchanged. What matters is that it
// costs nothing, records what an app sends, and hands an inbound message to
// its receiver — but only for the relayer.

use hyperveil::lz::{
    Bytes32, IEndpointV2Dispatcher, IEndpointV2DispatcherTrait, MessagingParams,
};
use hyperveil::mocks::{IMockLzReceiverDispatcher, IMockLzReceiverDispatcherTrait};
use hyperveil::relay_endpoint::{
    IHyperVeilRelayEndpointDispatcher, IHyperVeilRelayEndpointDispatcherTrait,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;

fn owner() -> ContractAddress { 0xA0.try_into().unwrap() }
fn relayer() -> ContractAddress { 0xB0.try_into().unwrap() }
fn stranger() -> ContractAddress { 0xD0.try_into().unwrap() }

const HL_EID: u32 = 40362;
const OMNIBUS: u256 = 0x1111111111111111111111111111111111111111;

fn deploy(name: ByteArray, calldata: Array<felt252>) -> ContractAddress {
    let class = declare(name).unwrap().contract_class();
    let (address, _) = class.deploy(@calldata).unwrap();
    address
}

fn setup() -> (ContractAddress, ContractAddress) {
    let endpoint = deploy("HyperVeilRelayEndpoint", array![owner().into(), relayer().into()]);
    let receiver = deploy("MockLzReceiver", array![]);
    (endpoint, receiver)
}

fn params(message: ByteArray) -> MessagingParams {
    MessagingParams {
        dst_eid: HL_EID,
        receiver: Bytes32 { value: OMNIBUS },
        message,
        options: Default::default(),
        pay_in_lz_token: false,
    }
}

#[test]
fn a_message_costs_nothing_and_is_recorded_for_the_relayer() {
    let (endpoint, _) = setup();
    let e = IEndpointV2Dispatcher { contract_address: endpoint };
    let quote = e.quote(params("HELLO"), stranger());
    assert(quote.native_fee == 0 && quote.lz_token_fee == 0, 'relay costs nothing');

    let receipt = e.send(params("HELLO"), stranger());
    assert(receipt.nonce == 1, 'first message');
    assert(
        IHyperVeilRelayEndpointDispatcher { contract_address: endpoint }.sent_count() == 1,
        'sent count',
    );
}

#[test]
fn the_relayer_delivers_a_message_as_the_endpoint_would() {
    let (endpoint, receiver) = setup();
    start_cheat_caller_address(endpoint, relayer());
    IHyperVeilRelayEndpointDispatcher { contract_address: endpoint }
        .deliver(receiver, HL_EID, Bytes32 { value: OMNIBUS }, "CREDIT");
    stop_cheat_caller_address(endpoint);

    let r = IMockLzReceiverDispatcher { contract_address: receiver };
    assert(r.received() == 1, 'delivered once');
    assert(r.last_src_eid() == HL_EID, 'src eid');
    assert(r.last_sender() == Bytes32 { value: OMNIBUS }, 'sender');
    assert(r.last_message() == "CREDIT", 'message');
}

#[test]
#[should_panic(expected: 'ONLY_RELAYER')]
fn nobody_else_delivers() {
    let (endpoint, receiver) = setup();
    start_cheat_caller_address(endpoint, stranger());
    IHyperVeilRelayEndpointDispatcher { contract_address: endpoint }
        .deliver(receiver, HL_EID, Bytes32 { value: OMNIBUS }, "CREDIT");
}

#[test]
fn the_owner_can_hand_the_relay_to_another_keeper() {
    let (endpoint, receiver) = setup();
    let e = IHyperVeilRelayEndpointDispatcher { contract_address: endpoint };
    start_cheat_caller_address(endpoint, owner());
    e.set_relayer(stranger());
    stop_cheat_caller_address(endpoint);
    assert(e.relayer() == stranger(), 'relayer changed');

    start_cheat_caller_address(endpoint, stranger());
    e.deliver(receiver, HL_EID, Bytes32 { value: OMNIBUS }, "CREDIT");
    stop_cheat_caller_address(endpoint);
    assert(IMockLzReceiverDispatcher { contract_address: receiver }.received() == 1, 'delivered');
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn nobody_else_changes_the_relayer() {
    let (endpoint, _) = setup();
    start_cheat_caller_address(endpoint, stranger());
    IHyperVeilRelayEndpointDispatcher { contract_address: endpoint }.set_relayer(stranger());
}
