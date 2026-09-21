// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Circle's contracts HyperVeil calls on HyperEVM, restated from source:
///   circlefin/evm-cctp-contracts   src/v2/TokenMessengerV2.sol, MessageTransmitterV2.sol
///   circlefin/hyperevm-circle-contracts   src/CoreDepositWallet.sol
///
/// HyperEVM mainnet (Circle docs, 2026-09-19): TokenMessengerV2
/// 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d, MessageTransmitterV2
/// 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64, USDC
/// 0xb88339CB7199b77E23DB6E890353E22632Ba630f. CCTP domains: HyperEVM 19,
/// Starknet 25.

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation)
        external
        returns (bool success);
}

/// USDC between HyperEVM and HyperCore. `deposit` credits the CALLER's
/// HyperCore account (6 -> 8 decimals); HyperCore -> EVM is a send-asset to
/// USDC's system address, which makes HyperCore call `transfer(sender, amount)`
/// here as that system address.
interface ICoreDepositWallet {
    function deposit(uint256 amount, uint32 destinationDex) external;
}
