// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// HyperVeil wire format, HyperEVM side. Byte-for-byte mirror of
/// `hyperveil/starknet/src/codec.cairo` (the table and the unit conventions are
/// documented there). Packed big-endian, kind byte first. Both test suites pin
/// the same hex vectors.
library HyperVeilCodec {
    uint8 internal constant KIND_DEPOSIT = 1;
    uint8 internal constant KIND_PLACE = 2;
    uint8 internal constant KIND_CANCEL = 3;
    uint8 internal constant KIND_WITHDRAW = 4;
    uint8 internal constant KIND_CREDIT = 5;
    uint8 internal constant KIND_FILL = 6;

    uint256 internal constant DEPOSIT_LEN = 49;
    uint256 internal constant PLACE_LEN = 135;
    uint256 internal constant CANCEL_LEN = 33;
    uint256 internal constant WITHDRAW_LEN = 49;
    uint256 internal constant CREDIT_LEN = 49;
    uint256 internal constant FILL_HEADER_LEN = 3;
    uint256 internal constant FILL_ITEM_LEN = 73;

    struct Place {
        bytes32 routeId;
        uint128 cloid;
        uint32 asset;
        bool isBuy;
        uint64 px;
        uint64 sz;
        uint8 tif;
        uint64 offerToken;
        uint64 wantToken;
        uint128 offerAmount;
        uint128 wantAmount;
        uint128 escrow;
    }

    struct FillItem {
        bytes32 routeId;
        uint64 seq;
        uint128 cumDraw;
        uint128 cumDeliver;
        bool closed;
    }

    error BadLength(uint256 got, uint256 want);
    error BadKind(uint8 got, uint8 want);

    /// `width` big-endian bytes at `offset`. Reverts (index out of range) on a
    /// short buffer: a truncated message is a protocol error.
    function readUint(bytes memory b, uint256 offset, uint256 width) internal pure returns (uint256 v) {
        require(offset + width <= b.length, "HV_MSG_TRUNCATED");
        for (uint256 i = 0; i < width; i++) {
            v = (v << 8) | uint8(b[offset + i]);
        }
    }

    function kind(bytes memory b) internal pure returns (uint8) {
        return uint8(readUint(b, 0, 1));
    }

    function _expect(bytes memory b, uint8 k, uint256 len) private pure {
        if (b.length != len) revert BadLength(b.length, len);
        if (kind(b) != k) revert BadKind(kind(b), k);
    }

    // ── Starknet -> HyperEVM ────────────────────────────────────────────────

    function encodeDeposit(bytes32 depositId, uint128 amountUsdc6) internal pure returns (bytes memory) {
        return abi.encodePacked(KIND_DEPOSIT, depositId, amountUsdc6);
    }

    function decodeDeposit(bytes memory b) internal pure returns (bytes32 depositId, uint128 amountUsdc6) {
        _expect(b, KIND_DEPOSIT, DEPOSIT_LEN);
        depositId = bytes32(readUint(b, 1, 32));
        amountUsdc6 = uint128(readUint(b, 33, 16));
    }

    function encodePlace(Place memory p) internal pure returns (bytes memory) {
        return bytes.concat(
            abi.encodePacked(KIND_PLACE, p.routeId, p.cloid, p.asset, p.isBuy, p.px, p.sz, p.tif),
            abi.encodePacked(p.offerToken, p.wantToken, p.offerAmount, p.wantAmount, p.escrow)
        );
    }

    function decodePlace(bytes memory b) internal pure returns (Place memory p) {
        _expect(b, KIND_PLACE, PLACE_LEN);
        p.routeId = bytes32(readUint(b, 1, 32));
        p.cloid = uint128(readUint(b, 33, 16));
        p.asset = uint32(readUint(b, 49, 4));
        p.isBuy = readUint(b, 53, 1) != 0;
        p.px = uint64(readUint(b, 54, 8));
        p.sz = uint64(readUint(b, 62, 8));
        p.tif = uint8(readUint(b, 70, 1));
        p.offerToken = uint64(readUint(b, 71, 8));
        p.wantToken = uint64(readUint(b, 79, 8));
        p.offerAmount = uint128(readUint(b, 87, 16));
        p.wantAmount = uint128(readUint(b, 103, 16));
        p.escrow = uint128(readUint(b, 119, 16));
    }

    function encodeCancel(bytes32 routeId) internal pure returns (bytes memory) {
        return abi.encodePacked(KIND_CANCEL, routeId);
    }

    function decodeCancel(bytes memory b) internal pure returns (bytes32) {
        _expect(b, KIND_CANCEL, CANCEL_LEN);
        return bytes32(readUint(b, 1, 32));
    }

    function encodeWithdraw(bytes32 exitId, uint128 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(KIND_WITHDRAW, exitId, amount);
    }

    function decodeWithdraw(bytes memory b) internal pure returns (bytes32 exitId, uint128 amount) {
        _expect(b, KIND_WITHDRAW, WITHDRAW_LEN);
        exitId = bytes32(readUint(b, 1, 32));
        amount = uint128(readUint(b, 33, 16));
    }

    // ── HyperEVM -> Starknet ────────────────────────────────────────────────

    function encodeCredit(bytes32 depositId, uint128 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(KIND_CREDIT, depositId, amount);
    }

    function decodeCredit(bytes memory b) internal pure returns (bytes32 depositId, uint128 amount) {
        _expect(b, KIND_CREDIT, CREDIT_LEN);
        depositId = bytes32(readUint(b, 1, 32));
        amount = uint128(readUint(b, 33, 16));
    }

    function encodeFill(FillItem[] memory items) internal pure returns (bytes memory out) {
        require(items.length > 0 && items.length <= type(uint16).max, "HV_FILL_SIZE");
        out = abi.encodePacked(KIND_FILL, uint16(items.length));
        for (uint256 i = 0; i < items.length; i++) {
            FillItem memory it = items[i];
            out = bytes.concat(
                out, abi.encodePacked(it.routeId, it.seq, it.cumDraw, it.cumDeliver, it.closed)
            );
        }
    }

    function decodeFill(bytes memory b) internal pure returns (FillItem[] memory items) {
        if (kind(b) != KIND_FILL) revert BadKind(kind(b), KIND_FILL);
        uint256 count = readUint(b, 1, 2);
        require(count > 0, "HV_EMPTY_FILL");
        uint256 len = FILL_HEADER_LEN + count * FILL_ITEM_LEN;
        if (b.length != len) revert BadLength(b.length, len);
        items = new FillItem[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 at = FILL_HEADER_LEN + i * FILL_ITEM_LEN;
            items[i] = FillItem({
                routeId: bytes32(readUint(b, at, 32)),
                seq: uint64(readUint(b, at + 32, 8)),
                cumDraw: uint128(readUint(b, at + 40, 16)),
                cumDeliver: uint128(readUint(b, at + 56, 16)),
                closed: readUint(b, at + 72, 1) != 0
            });
        }
    }
}
