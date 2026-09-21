#!/usr/bin/env node
// Put an account on HyperVeil's KYC list, or take it off.
//
//   node whitelist.js --account 0x… [--account 0x… …]
//   node whitelist.js --account 0x… --remove
//   node whitelist.js --account 0x… --check
//
// Only a WHITELISTER_ROLE holder may do this — the KYC operator named at
// deployment. Until the Open Market KYC integration lands, this script IS the
// KYC step: on testnet, whitelist yourself before trying anything.
//
// Note what it gates: the twins AND the real USDC and STRK in HyperVeil's
// pool (they are rules tokens reading this same list). An account that is not
// on it cannot hold, deposit or receive any of them inside the pool.

const { network } = require('./config');
const {
  parseArgs, loadDeployment, requireEnv, starknetAccount, snCall, snSend, done, step,
} = require('./lib');

async function main() {
  const args = parseArgs(process.argv);
  const snNet = network(args.starknet);
  const d = loadDeployment(args);
  if (!d.starknet.permissionManager) throw new Error('deploy the Starknet half first');
  const accounts = [].concat(args.account || []).filter(Boolean);
  if (!accounts.length) throw new Error('--account 0x<address> is required (repeat it for more)');

  const [snAddress, snKey] = requireEnv('SN_ACCOUNT_ADDRESS', 'SN_PRIVATE_KEY');
  const { provider, account } = starknetAccount(process.env.SN_RPC_URL || snNet.rpc, snAddress, snKey);
  const pm = d.starknet.permissionManager;
  console.log(`permission manager  ${pm}`);

  step(1, args.check ? 1 : 2, 'current state');
  const state = [];
  for (const a of accounts) {
    const on = BigInt((await snCall(provider, pm, 'is_whitelisted', [a]))[0]) === 1n;
    state.push([a, on]);
    done(a, on ? 'whitelisted' : 'not whitelisted');
  }
  if (args.check) return;

  const remove = Boolean(args.remove);
  const todo = state.filter(([, on]) => on !== !remove).map(([a]) => a);
  step(2, 2, remove ? 'unwhitelist' : 'whitelist');
  if (!todo.length) {
    done('nothing to do', 'every account is already in that state');
    return;
  }
  await snSend(
    account, provider, remove ? 'unwhitelist' : 'whitelist', pm,
    remove ? 'unwhitelist' : 'whitelist', [String(todo.length), ...todo], snNet.explorer,
  );
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
