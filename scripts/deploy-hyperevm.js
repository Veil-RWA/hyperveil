#!/usr/bin/env node
// Deploy HyperVeil's HyperEVM half: the omnibus.
//
//   node deploy-hyperevm.js [--evm hyperevm-testnet] [--starknet starknet-sepolia]
//
// The omnibus is ~18.5 KB of runtime code, so its deployment needs more gas
// than a HyperEVM small block allows (3M). The script therefore switches the
// deployer to big blocks (30M) for the deployment and switches back after —
// that flag is an `evmUserModify` L1 action, which needs the deployer to have
// a HyperCore account (on testnet: the faucet gives one).
//
// Resumable: the address is written to the deployment file as soon as it
// exists, so a failure afterwards does not mean paying for the deployment
// again.

const path = require('path');
const { ethers } = require('ethers');
const { compile } = require('../evm/test/harness');
const { network } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, evmProvider, step, done,
} = require('./lib');
const hl = require('./hl');

/// Deploying to a small block never reverts — it simply is not included, so
/// the wait must be bounded and explained rather than left hanging.
const DEPLOY_TIMEOUT_MS = 180_000;

async function main() {
  const args = parseArgs(process.argv);
  const net = network(args.evm);
  if (net.kind !== 'evm') throw new Error(`${args.evm} is not a HyperEVM network`);
  const isMainnet = args.evm.endsWith('mainnet');
  if (!net.coreDepositWallet) {
    throw new Error(`no CoreDepositWallet pinned for ${args.evm} — fill it in scripts/config.js first`);
  }

  const [key] = requireEnv('EVM_PRIVATE_KEY');
  const rpc = process.env.EVM_RPC_URL || net.rpc;
  const provider = evmProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const d = loadDeployment(args);

  const chain = await provider.getNetwork();
  if (Number(chain.chainId) !== net.chainId) {
    throw new Error(`${rpc} is chain ${chain.chainId}, not ${args.evm} (${net.chainId})`);
  }
  console.log(`network      ${args.evm} (chainId ${net.chainId}, eid ${net.eid})`);
  console.log(`rpc          ${rpc}`);
  console.log(`deployer     ${wallet.address}`);
  console.log(`balance      ${ethers.formatEther(await provider.getBalance(wallet.address))} HYPE`);
  console.log(`endpoint     ${args.relay ? '(relay, deployed below)' : net.endpoint}`);
  console.log(`USDC         ${net.usdc}`);

  const total = args.relay ? 5 : 4;
  let step_ = 0;

  // TESTNET ONLY: LayerZero has not enabled the HyperEVM testnet <-> Starknet
  // Sepolia pathway, so the omnibus is deployed against a relay endpoint the
  // keeper drives. The omnibus itself is unchanged; a mainnet deployment uses
  // the real endpoint and none of this exists there.
  let endpointAddress = net.endpoint;
  if (args.relay) {
    if (isMainnet) throw new Error('--relay is testnet only');
    step(++step_, total, 'HyperVeilRelayEndpoint (stands in for LayerZero)');
    if (d.evm.relayEndpoint) {
      done('already deployed', d.evm.relayEndpoint);
    } else {
      const relayer = args['keeper-evm'] || d.wired.keeperEvm || wallet.address;
      const art = compile().HyperVeilRelayEndpoint;
      const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
      const c = await factory.deploy(wallet.address, relayer);
      await c.waitForDeployment();
      d.evm.relayEndpoint = await c.getAddress();
      d.wired.keeperEvm = d.wired.keeperEvm || relayer;
      saveDeployment(args, d);
      done('deployed', d.evm.relayEndpoint, `${net.explorer}/address/${d.evm.relayEndpoint}`);
      done('relayer', relayer);
    }
    endpointAddress = d.evm.relayEndpoint;
  }

  step(++step_, total, 'the deployer on HyperCore');
  const deployerOnCore = await hl.coreUserExists(provider, wallet.address);
  done('HyperCore account', deployerOnCore ? 'exists' : 'MISSING');
  if (!deployerOnCore) {
    throw new Error(
      'the deployer has no HyperCore account, so it cannot set the big-block flag.\n' +
      (isMainnet
        ? '  Send it some USDC on HyperCore first.'
        : '  Testnet: claim 1000 mock USDC at https://app.hyperliquid-testnet.xyz/drip\n' +
          '  (only an address that has deposited on MAINNET can claim).')
    );
  }

  step(++step_, total, 'HyperVeilOmnibus');
  if (d.evm.omnibus) {
    done('already deployed', d.evm.omnibus);
  } else {
    const artifacts = compile();
    const art = artifacts.HyperVeilOmnibus;
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
    const ctor = [
      endpointAddress, wallet.address, d.starknetEid, net.usdc, net.tokenMessenger,
      net.messageTransmitter, net.coreDepositWallet,
    ];
    const gasLimit = await provider.estimateGas({
      from: wallet.address,
      data: (await factory.getDeployTransaction(...ctor)).data,
    });
    done('deployment gas', `${gasLimit} (small blocks allow 3M)`);

    // Big blocks only for as long as the deployment needs them: the flag stays
    // on the HyperCore user until it is unset, and everything else — the
    // keeper's reports, LayerZero deliveries — belongs in the fast blocks.
    console.log('      switching the deployer to big blocks…');
    await hl.setBigBlocks(net.hlApi, wallet, true, isMainnet);
    try {
      const c = await factory.deploy(...ctor, { gasLimit: (gasLimit * 12n) / 10n });
      const tx = c.deploymentTransaction();
      done('sent', tx.hash);
      console.log('      waiting for a big block (up to a minute)…');
      const receipt = await provider.waitForTransaction(tx.hash, 1, DEPLOY_TIMEOUT_MS);
      if (!receipt) {
        throw new Error(
          `not mined within ${DEPLOY_TIMEOUT_MS / 1000}s. Big blocks come once a minute; ` +
          'check the flag took effect and retry — the transaction may still land.'
        );
      }
      if (receipt.status !== 1) throw new Error(`deployment reverted: ${tx.hash}`);
      d.evm.omnibus = await c.getAddress();
      d.evm.deployBlock = receipt.blockNumber;
      d.evm.owner = wallet.address;
      d.evm.endpoint = endpointAddress;
      saveDeployment(args, d);
      done('deployed', d.evm.omnibus, `${net.explorer}/address/${d.evm.omnibus}`);
    } finally {
      console.log('      switching the deployer back to small blocks…');
      await hl.setBigBlocks(net.hlApi, wallet, false, isMainnet).catch((e) => {
        console.log(`      WARNING: could not switch back: ${e.message}`);
      });
    }
  }

  step(++step_, total, 'the omnibus on HyperCore');
  const onCore = await hl.coreUserExists(provider, d.evm.omnibus);
  done('HyperCore account', onCore ? 'exists' : 'NOT ACTIVATED YET');
  if (!onCore) {
    console.log('      Nothing it sends through CoreWriter runs until this account exists.');
    console.log('      Activate it by sending it USDC on HyperCore (spot transfer), e.g. from');
    console.log(`      ${isMainnet ? 'app.hyperliquid.xyz' : 'app.hyperliquid-testnet.xyz'} → Send:`);
    console.log(`        ${d.evm.omnibus}`);
    console.log('      Then run `node wire.js`, which checks it again before setting the');
    console.log('      account mode. On testnet this may fail for a fresh contract address:');
    console.log('      hyperliquid-dex/node issue #138.');
  }

  step(++step_, total, 'USDC balances');
  const bal = await hl.spotBalance(provider, d.evm.omnibus, 0);
  done('HyperCore USDC', `${bal.total} (8 dp)`);
  const usdc = new ethers.Contract(net.usdc, ['function balanceOf(address) view returns (uint256)'], provider);
  done('HyperEVM USDC', String(await usdc.balanceOf(d.evm.omnibus)));

  const file = saveDeployment(args, d);
  console.log(`\nwritten to ${path.relative(process.cwd(), file)}`);
  console.log('\nnext:');
  console.log('  node deploy-starknet.js');
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
