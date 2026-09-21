// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ILayerZeroEndpointV2,
    ILayerZeroReceiver,
    MessagingFee,
    MessagingParams,
    MessagingReceipt,
    Origin
} from "./ILayerZeroEndpointV2.sol";

/// The parts of LayerZero's `OApp` HyperVeil uses: an endpoint binding, a peer
/// table, a guarded payable receive, and a send whose fee the app pays from its
/// own balance. Same shape as the Veil bridge's OAppLite
/// (bridge/evm/contracts/lz), with one difference: the omnibus replies from
/// inside and outside `lzReceive` with HYPE the Starknet side sent along with
/// the instruction, so the send takes an explicit value instead of `msg.value`.
abstract contract OAppLite is ILayerZeroReceiver {
    ILayerZeroEndpointV2 public immutable endpoint;
    address public owner;

    /// Destination eid -> the 32-byte address of the counterpart there. A
    /// Starknet peer is its contract address as a 32-byte word.
    mapping(uint32 => bytes32) public peers;

    event PeerSet(uint32 indexed eid, bytes32 peer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error OnlyEndpoint();
    error OnlyPeer(uint32 eid, bytes32 sender);
    error NoPeer(uint32 eid);
    error ZeroAddress();

    constructor(address endpoint_, address owner_) {
        if (endpoint_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        endpoint = ILayerZeroEndpointV2(endpoint_);
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    function setDelegate(address delegate) external onlyOwner {
        endpoint.setDelegate(delegate);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        bytes32 peer = peers[origin.srcEid];
        if (peer == bytes32(0)) revert NoPeer(origin.srcEid);
        if (peer != origin.sender) revert OnlyPeer(origin.srcEid, origin.sender);
        _lzReceive(origin, guid, message, executor, extraData);
    }

    function _lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) internal virtual;

    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        bytes32 peer = peers[origin.srcEid];
        return peer != bytes32(0) && peer == origin.sender;
    }

    /// 0 = unordered. HyperVeil's reports carry their own per-route sequence.
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    function _peerOrRevert(uint32 eid) internal view returns (bytes32) {
        bytes32 peer = peers[eid];
        if (peer == bytes32(0)) revert NoPeer(eid);
        return peer;
    }

    function _params(uint32 dstEid, bytes memory message, bytes memory options)
        internal
        view
        returns (MessagingParams memory)
    {
        return MessagingParams({
            dstEid: dstEid,
            receiver: _peerOrRevert(dstEid),
            message: message,
            options: options,
            payInLzToken: false
        });
    }

    function _quote(uint32 dstEid, bytes memory message, bytes memory options)
        internal
        view
        returns (MessagingFee memory)
    {
        return endpoint.quote(_params(dstEid, message, options), address(this));
    }

    /// Sends paying `value` from this contract's balance; any refund comes back
    /// here.
    function _lzSendValue(uint32 dstEid, bytes memory message, bytes memory options, uint256 value)
        internal
        returns (MessagingReceipt memory)
    {
        return endpoint.send{value: value}(_params(dstEid, message, options), address(this));
    }

    /// Type-3 executor options carrying a single `lzReceive` gas limit — the
    /// same bytes as `build_lz_receive_options(gas, 0)` in hyperveil/starknet.
    function _lzReceiveOptions(uint128 gasLimit) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gasLimit);
    }
}
