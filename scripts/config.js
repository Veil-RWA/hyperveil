// Network constants for HyperVeil's deployment scripts.
//
// Everything here is pinned, never fetched at deploy time: these addresses ARE
// the security of the bridge between the omnibus and the gateway, and a script
// that picked them up from an API would follow whatever the API said. Sources
// and the date each was read are named per block.

const path = require('path');

const NETWORKS = {
  // ── HyperEVM (the omnibus) ────────────────────────────────────────────────
  // LayerZero metadata API (metadata.layerzero-api.com/v1/metadata/
  // deployments), read 2026-09-19. Circle: developers.circle.com (CCTP
  // contracts, and "Transfer USDC from HyperEVM to HyperCore" for the
  // CoreDepositWallet), read 2026-09-19. Chain ids and RPCs: Hyperliquid docs.
  'hyperevm-testnet': {
    kind: 'evm',
    chainId: 998,
    eid: 40362,
    rpc: 'https://rpc.hyperliquid-testnet.xyz/evm',
    endpoint: '0xf9e1815f151024bde4b7c10bac10e8ba9f6b53e1',
    sendLib: '0x43e505ba192aac7babdc1a796c87844171011684',
    receiveLib: '0x012f6eae2a0bf5916f48b5f37c62bcfb7c1ffda1',
    executor: '0x72e34f44eb09058bddaf1aeeebdec062f1844b00',
    dvns: {
      'LayerZero Labs': '0x91e698871030d0e1b6c9268c20bb57e2720618dd',
      P2P: '0x4c90f152707c6eab6cd801e326d25b0591e449a2',
      Bridge: '0xa09107603a9e349d1fac356c7b5325d085120c63',
    },
    usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    coreDepositWallet: '0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206',
    hlApi: 'https://api.hyperliquid-testnet.xyz',
    explorer: 'https://app.hyperliquid-testnet.xyz/explorer',
  },
  'hyperevm-mainnet': {
    kind: 'evm',
    chainId: 999,
    eid: 30367,
    rpc: 'https://rpc.hyperliquid.xyz/evm',
    endpoint: '0x3a73033c0b1407574c76bdbac67f126f6b4a9aa9',
    sendLib: '0xfd76d9cb0bac839725ab79127e7411fe71b1e3ca',
    receiveLib: '0x7cacbe439ead55fa1c22790330b12835c6884a91',
    executor: '0x41bdb4aa4a63a5b2efc531858d3118392b1a1c3d',
    dvns: {
      'LayerZero Labs': '0xc097ab8cd7b053326dfe9fb3e3a31a0cce3b526f',
      Nethermind: '0x8e49ef1dfae17e547ca0e7526ffda81fbaca810a',
      Horizen: '0xbb83ecf372cbb6daa629ea9a9a53bec6d601f229',
      P2P: '0xc7423626016bc40375458bc0277f28681ec91c8e',
      Luganodes: '0x9e451905f65ef78d62b93dac3513486da8429d0a',
      BitGo: '0xf55e9daef79eec17f76e800f059495f198ef8348',
      Canary: '0x83342ec538df0460e730a8f543fe63063e2d44c4',
      Nansen: '0xcfe987ebff7612b53d145dd70ee24d00e12d6a1f',
      'Deutsche Telekom': '0x32ffd21260172518a8844fec76a88c8f239c384b',
    },
    usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    // Not published in Circle's docs page that lists the testnet one: take it
    // from Circle's HyperEVM deployment before a mainnet run.
    coreDepositWallet: '',
    hlApi: 'https://api.hyperliquid.xyz',
    explorer: 'https://app.hyperliquid.xyz/explorer',
  },

  // ── Starknet (the pool, gateway, twins, vault) ────────────────────────────
  // LayerZero as above. Circle CCTP on Starknet: developers.circle.com
  // quickstart "Transfer USDC between Starknet and Arc", read 2026-09-19.
  'starknet-sepolia': {
    kind: 'starknet',
    chainId: '0x534e5f5345504f4c4941',
    eid: 40500,
    rpc: 'https://starknet-sepolia.drpc.org',
    endpoint: '0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878',
    sendLib: '0x0706572d6f7b938c813a20dc1b0328b83de939066e25bd0fbe14c270077f769d',
    receiveLib: '0x0706572d6f7b938c813a20dc1b0328b83de939066e25bd0fbe14c270077f769d',
    executor: '0x068ffdaca6533001344f377beaf1137360168604b227df3e8cf735fe06da47a9',
    dvns: {
      // The only DVN LayerZero runs on Starknet Sepolia.
      'LayerZero Labs': '0x06d1be34defe7d8e0b7db0741b09345f7328ab8a49b9ad4e538f1dc7b5e07862',
    },
    // STRK: the token the Starknet endpoint charges fees in, and a pool token
    // here, because HyperVeil's fees are paid from private STRK.
    strk: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    usdc: '0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343',
    tokenMessenger: '0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370',
    messageTransmitter: '0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8',
    explorer: 'https://sepolia.voyager.online',
  },
  'starknet-mainnet': {
    kind: 'starknet',
    chainId: '0x534e5f4d41494e',
    eid: 30500,
    rpc: 'https://starknet-mainnet.public.blastapi.io/rpc/v0_8',
    endpoint: '0x0524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68',
    sendLib: '0x0727f40349719ac76861a51a0b3d3e07be1577fff137bb81a5dc32e5a5c61d38',
    receiveLib: '0x0727f40349719ac76861a51a0b3d3e07be1577fff137bb81a5dc32e5a5c61d38',
    executor: '0x03887bd8da2999d39e2e88fe55733c4cac8e20a6d51bfe162176c9f2eb134c65',
    dvns: {
      'LayerZero Labs': '0x067ba9b8e08d78e4600871db457f9620c56c39915167d32b0581a7fb639866dd',
      Nethermind: '0x005fe707754524f23e788abfc2d159a8e8d400a59eedc07c00aa10ed9850adfb',
      Horizen: '0x067f770461867f3634a7f836e96e4f6649c4bbe6972b70e2838b9590e0828e63',
      P2P: '0x057deaedc4e2ca6c6d6e99e41777f8b4dec9936e4035f047082889b3f43f8f8e',
      Luganodes: '0x014a2520ccbb12eedc6dc8131799d8099f7078c9f751ad79fe721c4d6d73545b',
      BitGo: '0x00fecc9a5aab62d1c14d85a5f01824ca0f731358606bbb1bff01d3c407121277',
      Canary: '0x073b30c6cf0094ca96976a6fa8c656d84f7ba88b4edfd068adf9ec0613a91982',
      Nansen: '0x0506d504f5b58dc10300ecb192b74e5f72e8bc76495d2d05af3acdb2a22432c3',
      'Deutsche Telekom': '0x02fff0fb1d28dae06f80120e17a26d23803234dd27d4b275f7742c97ecbfb3f5',
    },
    strk: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    // Circle's native USDC on Starknet mainnet: fill before a mainnet run.
    usdc: '',
    tokenMessenger: '',
    messageTransmitter: '',
    explorer: 'https://voyager.online',
  },
};

/// The DVN set configure-dvns.js applies when told nothing. On the testnet
/// pathway LayerZero Labs is the ONLY provider running on both chains
/// (metadata API, 2026-09-19); on mainnet nine do, and two independent ones
/// are the default.
const DEFAULT_DVNS = {
  mainnet: ['LayerZero Labs', 'Nethermind'],
  testnet: ['LayerZero Labs'],
};

const DEFAULT_EVM = 'hyperevm-testnet';
const DEFAULT_STARKNET = 'starknet-sepolia';

/// The HyperCore spot tokens that get a twin. USDC (token 0) is always one:
/// it is what a deposit credits and what an exit burns. The rest are named by
/// their HyperCore ticker and resolved against the info API at deploy time
/// (index, szDecimals, weiDecimals), so nothing about a token is guessed.
const DEFAULT_TOKENS = ['PURR'];

/// What the omnibus pays to send USDC back (`setExitCctp`). Fast, for the same
/// reason as the deposit leg; Circle quotes 0 bps HyperEVM -> Starknet today,
/// and the vault credits whatever actually arrives, so a cap only has to be
/// high enough never to refuse the burn.
const EXIT_CCTP = { maxFee: 50000n, minFinality: 1000 };

/// Per-kind `lz_receive` gas the gateway asks for on HyperEVM (EVM gas).
/// Measured in hyperveil/evm's harness, 2026-09-19: DEPOSIT ~108k, PLACE ~403k
/// (a rejected one also sends a FILL back), CANCEL ~144k, WITHDRAW ~283k. Set
/// with ~2x headroom, and far below HyperEVM's 3M small-block limit.
const GATEWAY_GAS = { 1: 250_000n, 2: 900_000n, 3: 300_000n, 4: 600_000n };

/// What the omnibus asks for when it answers, in Starknet L2 gas. Measured
/// against the real Veil pool (snforge, 2026-09-19): a CREDIT ~11M, a FILL ~4M
/// plus ~12M per item. Same values as the omnibus's own defaults.
const OMNIBUS_GAS = { credit: 40_000_000n, fillBase: 20_000_000n, fillPerItem: 30_000_000n };

/// Hyperliquid's worst spot fee in bps, as the omnibus assumes when it bounds
/// an order (base taker fee is 7 bps; tiers only lower it). The keeper's
/// HV_MAX_FEE_BPS must match.
const MAX_FEE_BPS = 10;

const DEPLOYMENTS_DIR = process.env.HV_DEPLOYMENTS_DIR || path.join(__dirname, '..', 'deployments');

function deploymentPath(evmNetwork, starknetNetwork) {
  return path.join(DEPLOYMENTS_DIR, `${evmNetwork}__${starknetNetwork}.json`);
}

function network(name) {
  const n = NETWORKS[name];
  if (!n) throw new Error(`unknown network "${name}". known: ${Object.keys(NETWORKS).join(', ')}`);
  return n;
}

module.exports = {
  NETWORKS,
  DEFAULT_DVNS,
  DEFAULT_EVM,
  DEFAULT_STARKNET,
  DEFAULT_TOKENS,
  EXIT_CCTP,
  GATEWAY_GAS,
  OMNIBUS_GAS,
  MAX_FEE_BPS,
  DEPLOYMENTS_DIR,
  deploymentPath,
  network,
};
