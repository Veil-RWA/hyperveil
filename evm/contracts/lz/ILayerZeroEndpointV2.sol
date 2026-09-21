// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal LayerZero V2 endpoint surface, vendored.
///
/// Structs and signatures copied verbatim from LayerZero-v2
/// `packages/layerzero-v2/evm/protocol/contracts/interfaces/ILayerZeroEndpointV2.sol`
/// and `ILayerZeroReceiver.sol`. Vendored rather than imported because
/// `script/build.js` compiles this tree with solc directly and resolves
/// imports only within `contracts/`. Same copy as the Veil bridge's
/// (bridge/evm/contracts/lz). Only the members HyperVeil uses are kept.
///
/// Deployed endpoints (LayerZero metadata API, verified 2026-09-19):
///   HyperEVM mainnet  eid 30367  0x3a73033c0b1407574c76bdbac67f126f6b4a9aa9
///   HyperEVM testnet  eid 40362  0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1
///   Starknet mainnet  eid 30500  0x0524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68
///   Starknet sepolia  eid 40500  0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878

struct MessagingParams {
    uint32 dstEid;
    bytes32 receiver;
    bytes message;
    bytes options;
    bool payInLzToken;
}

struct MessagingFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

struct MessagingReceipt {
    bytes32 guid;
    uint64 nonce;
    MessagingFee fee;
}

struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

interface ILayerZeroEndpointV2 {
    function send(MessagingParams calldata _params, address _refundAddress)
        external
        payable
        returns (MessagingReceipt memory);

    function quote(MessagingParams calldata _params, address _sender)
        external
        view
        returns (MessagingFee memory);

    function setDelegate(address _delegate) external;
}

interface ILayerZeroReceiver {
    function allowInitializePath(Origin calldata _origin) external view returns (bool);

    function nextNonce(uint32 _eid, bytes32 _sender) external view returns (uint64);

    function lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) external payable;
}
