// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Hyperliquid's HyperEVM <-> HyperCore surface, restated from the official
/// docs ("Interacting with HyperCore") and their attached `L1Read.sol` and
/// `CoreWriter.sol`, read 2026-09-19.
///
/// Reads: precompiles at 0x...0800 onward return the HyperCore state as of the
/// moment the EVM block was built. A precompile called with an invalid input
/// (an unknown asset or token) errors and burns all gas it was given, so the
/// `try*` readers cap the gas and report failure instead of reverting.
///
/// Writes: the CoreWriter system contract turns a log into a HyperCore action,
/// executed after the EVM block, on behalf of the calling contract's own
/// HyperCore account. Order actions are delayed a few seconds on purpose. The
/// account must already exist on HyperCore, and must not be a multi-sig user.
/// Actions are fire-and-forget: HyperCore may reject one and the EVM never
/// learns it — which is why HyperVeil's keeper reports results.
///
/// Action encoding: byte 1 version (1), bytes 2-4 action id (big-endian),
/// then the raw ABI encoding of the action's fields.
interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}

library HyperCore {
    address internal constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address internal constant SPOT_BALANCE = 0x0000000000000000000000000000000000000801;
    address internal constant SPOT_INFO = 0x000000000000000000000000000000000000080b;
    address internal constant TOKEN_INFO = 0x000000000000000000000000000000000000080C;
    address internal constant CORE_USER_EXISTS = 0x0000000000000000000000000000000000000810;

    /// The spot "dex" in send-asset actions.
    uint32 internal constant SPOT_DEX = type(uint32).max;

    uint24 internal constant ACTION_LIMIT_ORDER = 1;
    uint24 internal constant ACTION_SEND_ASSET = 13;
    uint24 internal constant ACTION_CANCEL_BY_CLOID = 11;
    uint24 internal constant ACTION_SET_ABSTRACTION = 16;

    /// Gas handed to a precompile read; bounds what a bad input can burn.
    uint256 internal constant READ_GAS = 100_000;

    struct SpotBalance {
        uint64 total;
        uint64 hold;
        uint64 entryNtl;
    }

    struct SpotInfo {
        string name;
        uint64[2] tokens;
    }

    struct TokenInfo {
        string name;
        uint64[] spots;
        uint64 deployerTradingFeeShare;
        address deployer;
        address evmContract;
        uint8 szDecimals;
        uint8 weiDecimals;
        int8 evmExtraWeiDecimals;
    }

    error PrecompileFailed(address precompile);

    function spotBalance(address user, uint64 token) internal view returns (SpotBalance memory) {
        (bool ok, bytes memory out) = SPOT_BALANCE.staticcall{gas: READ_GAS}(abi.encode(user, token));
        if (!ok) revert PrecompileFailed(SPOT_BALANCE);
        return abi.decode(out, (SpotBalance));
    }

    function trySpotInfo(uint32 spot) internal view returns (bool, SpotInfo memory info) {
        (bool ok, bytes memory out) = SPOT_INFO.staticcall{gas: READ_GAS}(abi.encode(spot));
        if (!ok || out.length == 0) return (false, info);
        return (true, abi.decode(out, (SpotInfo)));
    }

    function tryTokenInfo(uint32 token) internal view returns (bool, TokenInfo memory info) {
        (bool ok, bytes memory out) = TOKEN_INFO.staticcall{gas: READ_GAS}(abi.encode(token));
        if (!ok || out.length == 0) return (false, info);
        return (true, abi.decode(out, (TokenInfo)));
    }

    /// Action 1. `limitPx` and `sz` are 10^8 x the human-readable value.
    /// `tif`: 1 Alo, 2 Gtc, 3 Ioc. `cloid` 0 means none.
    function limitOrder(
        uint32 asset,
        bool isBuy,
        uint64 limitPx,
        uint64 sz,
        bool reduceOnly,
        uint8 tif,
        uint128 cloid
    ) internal {
        _send(ACTION_LIMIT_ORDER, abi.encode(asset, isBuy, limitPx, sz, reduceOnly, tif, cloid));
    }

    /// Action 11.
    function cancelByCloid(uint32 asset, uint128 cloid) internal {
        _send(ACTION_CANCEL_BY_CLOID, abi.encode(asset, cloid));
    }

    /// Action 13. To a token's system address this moves Core spot to the EVM
    /// (the linked contract's `transfer` is called for the sender).
    function sendAsset(
        address destination,
        address subAccount,
        uint32 sourceDex,
        uint32 destinationDex,
        uint64 token,
        uint64 amountWei
    ) internal {
        _send(
            ACTION_SEND_ASSET,
            abi.encode(destination, subAccount, sourceDex, destinationDex, token, amountWei)
        );
    }

    /// Action 16. 1 disabled (standard), 2 unified account, 3 portfolio margin.
    function setAbstraction(address user, uint8 abstraction) internal {
        _send(ACTION_SET_ABSTRACTION, abi.encode(user, abstraction));
    }

    function _send(uint24 actionId, bytes memory encoded) private {
        ICoreWriter(CORE_WRITER).sendRawAction(abi.encodePacked(uint8(1), actionId, encoded));
    }
}
