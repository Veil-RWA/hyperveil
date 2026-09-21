// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ILayerZeroEndpointV2,
    ILayerZeroReceiver,
    MessagingFee,
    MessagingParams,
    MessagingReceipt,
    Origin
} from "./lz/ILayerZeroEndpointV2.sol";

/// HyperVeilRelayEndpoint — a stand-in for LayerZero's endpoint, for TESTNET.
///
/// LayerZero has not enabled the HyperEVM testnet (eid 40362) <-> Starknet
/// Sepolia (eid 40500) pathway: this endpoint reports
/// `isSupportedEid(40500) = false` and has no default libraries for it, so the
/// omnibus cannot send or receive there. This contract stands in its place so
/// HyperVeil can be exercised end to end on testnet.
///
/// The omnibus is UNCHANGED: it takes its endpoint at construction and speaks
/// the same interface to this one. A mainnet deployment points at the real
/// endpoint and this contract does not exist there, so "testnet only" is a
/// property of the deployment, not a flag.
///
/// `deliver` is relayer-only: whoever can call it can make the omnibus believe
/// anything the gateway could say — place an order, release an exit. That is
/// the trust LayerZero's DVNs remove on mainnet, and why this is testnet only.
contract HyperVeilRelayEndpoint is ILayerZeroEndpointV2 {
    address public owner;
    address public relayer;
    uint64 public sentCount;

    event RelayOut(
        uint64 indexed nonce,
        address indexed sender,
        uint32 dstEid,
        bytes32 receiver,
        bytes message,
        bytes options
    );
    event RelayIn(address indexed receiver, uint32 srcEid, bytes32 sender);
    event RelayerSet(address relayer);

    error OnlyOwner();
    error OnlyRelayer();

    constructor(address owner_, address relayer_) {
        owner = owner_;
        relayer = relayer_;
    }

    /// Whatever value an app sends is returned to it: there are no workers to
    /// pay, and the omnibus funds its replies from the value it was given.
    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        sentCount += 1;
        emit RelayOut(sentCount, msg.sender, params.dstEid, params.receiver, params.message, params.options);
        if (msg.value > 0) {
            (bool ok,) = (refundAddress == address(0) ? msg.sender : refundAddress).call{value: msg.value}("");
            require(ok, "HV_RELAY_REFUND");
        }
        receipt.guid = bytes32(uint256(sentCount));
        receipt.nonce = sentCount;
        receipt.fee = MessagingFee(0, 0);
    }

    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory) {
        return MessagingFee(0, 0);
    }

    function setDelegate(address) external {}

    /// Relayer only. Hands an inbound message to `receiver` as the endpoint
    /// would, with `sender` on `srcEid` as its origin.
    function deliver(address receiver, uint32 srcEid, bytes32 sender, bytes calldata message) external {
        if (msg.sender != relayer) revert OnlyRelayer();
        sentCount += 1;
        ILayerZeroReceiver(receiver).lzReceive(
            Origin(srcEid, sender, sentCount), bytes32(uint256(sentCount)), message, msg.sender, ""
        );
        emit RelayIn(receiver, srcEid, sender);
    }

    function setRelayer(address relayer_) external {
        if (msg.sender != owner) revert OnlyOwner();
        relayer = relayer_;
        emit RelayerSet(relayer_);
    }
}
