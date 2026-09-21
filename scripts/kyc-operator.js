#!/usr/bin/env node
// Give the KYC service the right to change the pool's allowlist, or take it
// back.
//
//   node kyc-operator.js --account 0x…            grant WHITELISTER_ROLE
//   node kyc-operator.js --account 0x… --remove   revoke it
//   node kyc-operator.js --account 0x… --check
//
// The permission manager's admin (the deployer) is the only one who can do
// this. WHITELISTER_ROLE is what `whitelist` / `unwhitelist` require, so until
// the KYC service's own Starknet account holds it, the service can read the KYC provider
// and decide, and change nothing. `whitelist.js` remains the manual path and
// keeps working either way — both are just holders of the same role.

const { network } = require('./config');
const {
  parseArgs, loadDeployment, requireEnv, starknetAccount, snCall, snSend, done, step, hex,
} = require('./lib');

// `selector!("WHITELISTER_ROLE")` in hyperveil/starknet/src/permission_manager.cairo.
const WHITELISTER_ROLE = require('starknet').hash.getSelectorFromName('WHITELISTER_ROLE');

async function main() {
  const args = parseArgs(process.argv);
  const snNet = network(args.starknet);
  const d = loadDeployment(args);
  if (!d.starknet.permissionManager) throw new Error('deploy the Starknet half first');
  const account_ = args.account;
  if (!account_) throw new Error('--account 0x<the KYC service\'s Starknet address> is required');

  const [snAddress, snKey] = requireEnv('SN_ACCOUNT_ADDRESS', 'SN_PRIVATE_KEY');
  const { provider, account } = starknetAccount(process.env.SN_RPC_URL || snNet.rpc, snAddress, snKey);
  const pm = d.starknet.permissionManager;
  console.log(`permission manager  ${pm}`);
  console.log(`role                WHITELISTER_ROLE (${WHITELISTER_ROLE})`);

  step(1, args.check ? 1 : 2, 'current state');
  const has = BigInt((await snCall(provider, pm, 'has_role', [WHITELISTER_ROLE, hex(account_)]))[0]) === 1n;
  done(account_, has ? 'is a whitelister' : 'is NOT a whitelister');
  if (args.check) return;

  const remove = Boolean(args.remove);
  step(2, 2, remove ? 'revoke_role' : 'grant_role');
  if (has !== remove) {
    done('nothing to do', has ? 'already granted' : 'already revoked');
    return;
  }
  await snSend(
    account, provider, remove ? 'revoke_role' : 'grant_role', pm,
    remove ? 'revoke_role' : 'grant_role', [WHITELISTER_ROLE, hex(account_)], snNet.explorer,
  );

  if (!remove) {
    console.log('\nThe KYC service can now whitelist and unwhitelist. Point it at this');
    console.log('permission manager (HV_PERMISSION_MANAGER in hyperveil/kyc/.env).');
  }
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
