// Shared helpers for HyperVeil's deployment scripts.

const fs = require('fs');
const path = require('path');
const {
  DEPLOYMENTS_DIR, deploymentPath, network, DEFAULT_EVM, DEFAULT_STARKNET,
} = require('./config');

function parseArgs(argv) {
  const out = { evm: DEFAULT_EVM, starknet: DEFAULT_STARKNET };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    // A flag with nothing usable after it is a BOOLEAN, so `--check --evm x`
    // does not read "--evm" as the value of --check.
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    out[key] = key in out && key !== 'evm' && key !== 'starknet' ? [].concat(out[key], value) : value;
  }
  return out;
}

/// Every script reads and writes this one file, so a half-finished deploy can
/// be resumed rather than restarted — which matters when step 5 of 9 fails and
/// the first four cost real gas.
function loadDeployment(args) {
  const file = deploymentPath(args.evm, args.starknet);
  if (!fs.existsSync(file)) {
    return {
      evmNetwork: args.evm,
      starknetNetwork: args.starknet,
      evmEid: network(args.evm).eid,
      starknetEid: network(args.starknet).eid,
      evm: {},
      starknet: {},
      twins: {},
      classes: {},
      wired: {},
    };
  }
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  d.evm = d.evm || {};
  d.starknet = d.starknet || {};
  d.twins = d.twins || {};
  d.classes = d.classes || {};
  d.wired = d.wired || {};
  return d;
}

function saveDeployment(args, data) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = deploymentPath(args.evm, args.starknet);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(
      `missing environment: ${missing.join(', ')}\n` +
      `  copy .env.example to .env and fill it in, then: set -a && . ./.env && set +a`
    );
  }
  return names.map((n) => process.env[n]);
}

/// An ethers provider. ethers caches identical requests for 250 ms, so on a
/// fast chain (HyperEVM makes a block a second) a transaction sent right after
/// another reads the first one's nonce again.
function evmProvider(rpc) {
  const { ethers } = require('ethers');
  return new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
}

/// Build a Starknet provider + account. starknet.js v10 takes an options
/// OBJECT here; the v6 positional form silently reads the provider as options.
function starknetAccount(rpcUrl, address, privateKey) {
  const { Account, RpcProvider } = require('starknet');
  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  const account = new Account({ provider, address, signer: privateKey });
  return { provider, account };
}

const asFelts = (result) => (Array.isArray(result) ? result : result.result ?? []);
const feltToBigInt = (result) => BigInt(asFelts(result)[0] ?? 0);
const u256FromFelts = (result) => {
  const f = asFelts(result);
  return BigInt(f[0] ?? 0) + (BigInt(f[1] ?? 0) << 128n);
};

const hex = (v) => '0x' + BigInt(v).toString(16);
/// Starknet u256 is two felts, low first.
const u256 = (v) => [hex(BigInt(v) & ((1n << 128n) - 1n)), hex(BigInt(v) >> 128n)];
/// An address as LayerZero's / CCTP's 32-byte word.
const word = (address) => '0x' + BigInt(address).toString(16).padStart(64, '0');
/// A Bytes32 as Cairo takes it: a u256, i.e. two felts (low, high).
const bytes32Calldata = (address) => u256(address);

function step(n, total, text) {
  console.log(`\n[${n}/${total}] ${text}`);
}

function done(label, value, explorer) {
  console.log(`      ${String(label).padEnd(24)} ${value}`);
  if (explorer) console.log(`      ${''.padEnd(24)} ${explorer}`);
}

/// Reads a Starknet contract, returning flat felts.
async function snCall(provider, contractAddress, entrypoint, calldata = []) {
  return asFelts(await provider.callContract({ contractAddress, entrypoint, calldata }));
}

/// Sends one Starknet call and waits for it.
async function snSend(account, provider, label, contractAddress, entrypoint, calldata, explorer) {
  const res = await account.execute({ contractAddress, entrypoint, calldata });
  await provider.waitForTransaction(res.transaction_hash);
  done(label, res.transaction_hash, explorer ? `${explorer}/tx/${res.transaction_hash}` : undefined);
  return res.transaction_hash;
}

module.exports = {
  parseArgs,
  loadDeployment,
  saveDeployment,
  requireEnv,
  evmProvider,
  starknetAccount,
  asFelts,
  feltToBigInt,
  u256FromFelts,
  hex,
  u256,
  word,
  bytes32Calldata,
  snCall,
  snSend,
  step,
  done,
  network,
};
