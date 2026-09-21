#!/usr/bin/env node
// Turn the deployment file into the two configurations that run HyperVeil:
// the app's `public/deployment.json` and the keeper's environment.
//
//   node write-config.js [--prover https://…] [--prover-master 0x…]
//                        [--intake http://localhost:8787]
//                        [--kyc https://…] [--no-open-allowlist] [--return-value 0]
//                        [--min-finality 1000] [--cctp-max-fee-bps 20]
//                        [--out ../app/public/deployment.json]
//                        [--keeper-env ../keeper/.env] [--kyc-env ../kyc/.env]
//
// `--return-value` is the HYPE (wei) each instruction carries to pay the
// omnibus's reply. It MUST be the same number in both files, which is why one
// script writes both: with 0 the omnibus's CREDIT and FILL revert with
// BudgetTooLow, and with different values the keeper's quotes do not match
// what the app prepaid.

const fs = require('fs');
const path = require('path');
const { network, MAX_FEE_BPS } = require('./config');
const { parseArgs, loadDeployment, step, done } = require('./lib');

/// The `KEY=value` lines of an env file, so a rewrite keeps what it must.
function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

function main() {
  const args = parseArgs(process.argv);
  const snNet = network(args.starknet);
  const evmNet = network(args.evm);
  const d = loadDeployment(args);
  if (!d.starknet.gateway) throw new Error('deploy the Starknet half first');
  // The omnibus may still be missing (deploy-starknet.js --no-omnibus). Write
  // what exists: the app then shows live Hyperliquid markets with every action
  // disabled, which is exactly the state of the deployment.
  if (!d.evm.omnibus) {
    console.log('note: no omnibus yet — the app will load but keep trading disabled\n');
  }

  const returnValue = String(args['return-value'] ?? d.wired.returnValue ?? '0');
  const appFile = path.resolve(args.out || path.join(__dirname, '..', 'app', 'public', 'deployment.json'));
  const envFile = path.resolve(args['keeper-env'] || path.join(__dirname, '..', 'keeper', '.env'));
  const network_ = args.starknet.endsWith('mainnet') ? 'mainnet' : 'testnet';

  step(1, 3, 'app: public/deployment.json');
  const app = {
    network: network_,
    starknet: {
      rpc: process.env.SN_PUBLIC_RPC_URL || snNet.rpc,
      chainId: snNet.chainId,
      deployBlock: d.starknet.deployBlock ?? 0,
      pool: d.starknet.pool,
      gateway: d.starknet.gateway,
      // Empty, never absent: the app reads "" as "not deployed" and keeps the
      // actions that need them disabled. `undefined` would vanish from the JSON.
      entryHelper: d.starknet.entryHelper || '',
      exitVault: d.starknet.exitVault || '',
      permissionManager: d.starknet.permissionManager || '',
      feeAdapter: d.starknet.feeAdapter || '',
      strk20Entry: d.starknet.strk20Entry || '',
      usdc: d.starknet.usdc,
      strk: d.starknet.strk,
      twins: Object.entries(d.twins).map(([name, t]) => ({
        hlToken: t.hlToken,
        address: t.address,
        symbol: t.symbol || `hv${name}`,
        decimals: t.decimals,
      })),
    },
    hyperliquid: { api: evmNet.hlApi },
    prover: {
      endpoint: args.prover || process.env.PROVER_ENDPOINT || '',
      transport: args.transport || 'job',
      masterAddress: args['prover-master'] || process.env.PROVER_MASTER || '',
    },
    keeper: { intake: args.intake || process.env.HV_INTAKE_URL || '' },
    // Where the KYC service answers. Empty = none: the app then
    // shows whether the account is on the allowlist and nothing more.
    kyc: { url: args.kyc || process.env.HV_KYC_URL || '' },
    fees: {
      returnValue,
      maxFeeBps: MAX_FEE_BPS,
      headroomPct: Number(args['headroom-pct'] ?? 30),
    },
    cctp: {
      // Fast (<= 1000), not standard. Circle's own table puts a standard
      // transfer FROM Starknet at ~65 Ethereum blocks — 2 to 4 hours — because
      // it waits for the zk proof to finalize on L1. Fast is ~20 seconds and
      // costs 14 bps from Starknet, 0 bps back.
      minFinality: Number(args['min-finality'] ?? 1000),
      // Basis points, not an absolute amount: the burn's cap is absolute, so
      // the app computes it per transfer from this rate. Headroom over the 14
      // Circle quotes today.
      maxFeeBps: Number(args['cctp-max-fee-bps'] ?? 20),
    },
  };
  fs.writeFileSync(appFile, JSON.stringify(app, null, 2) + '\n');
  done('written', appFile);
  const missing = Object.entries(app.starknet)
    .filter(([k, v]) => typeof v === 'string' && !v && k !== 'strk20Entry')
    .map(([k]) => k);
  if (missing.length) done('INCOMPLETE', `no address for: ${missing.join(', ')}`);
  if (!app.prover.endpoint) done('note', 'no prover endpoint: proving falls back to the SDK default');
  // Without it the SDK has nothing to submit a settle from, and every proven
  // action dies with "no master account configured". veilx and the bridge
  // frontend carry the same value in their own .env.
  if (!app.prover.masterAddress) {
    done('INCOMPLETE', 'no prover master account: every proven action will fail (--prover-master 0x…)');
  }
  if (!app.keeper.intake) done('note', 'no keeper intake URL: orders cannot reach the keeper');
  if (!app.kyc.url) done('note', 'no KYC service URL configured');

  step(2, 3, 'keeper: .env');
  // Keys already in the file survive a rewrite: this script is re-run every
  // time an address changes, and blanking them would silently break the next
  // `aws/deploy.sh` (and any running keeper restarted from this file).
  const previous = readEnv(envFile);
  const keep = (k) => previous[k] || '';
  const env = [
    '# HyperVeil keeper — written by scripts/write-config.js. Add the two keys.',
    `HV_NETWORK=${network_}`,
    `SN_RPC_URL=${process.env.SN_RPC_URL || snNet.rpc}`,
    'SN_KEEPER_ADDRESS=' + (d.wired.keeperSn || ''),
    'SN_KEEPER_PRIVATE_KEY=' + keep('SN_KEEPER_PRIVATE_KEY'),
    `VEIL_POOL=${d.starknet.pool || ''}`,
    `HV_GATEWAY=${d.starknet.gateway || ''}`,
    `HV_ENTRY_HELPER=${d.starknet.entryHelper || ''}`,
    `HV_EXIT_VAULT=${d.starknet.exitVault || ''}`,
    `HV_PERMISSION_MANAGER=${d.starknet.permissionManager || ''}`,
    `SN_STRK=${d.starknet.strk || ''}`,
    `SN_START_BLOCK=${d.starknet.deployBlock ?? 0}`,
    '',
    `EVM_RPC_URL=${process.env.EVM_RPC_URL || evmNet.rpc}`,
    'EVM_KEEPER_PRIVATE_KEY=' + keep('EVM_KEEPER_PRIVATE_KEY'),
    `HV_OMNIBUS=${d.evm.omnibus || ''}`,
    `EVM_START_BLOCK=${d.evm.deployBlock ?? 0}`,
    '',
    ...(d.starknet.relayEndpoint && d.evm.relayEndpoint
      ? [
          '# TESTNET ONLY: LayerZero has no pathway here, so the keeper carries',
          '# the messages between the relay endpoints (keeper/src/relay.ts).',
          'HV_RELAY=1',
          `HV_SN_RELAY_ENDPOINT=${d.starknet.relayEndpoint}`,
          `HV_EVM_RELAY_ENDPOINT=${d.evm.relayEndpoint}`,
          '',
        ]
      : []),
    ...(network_ === 'testnet'
      ? [
          '# TESTNET ONLY: anyone who asks the intake is put on the pool\'s',
          '# allowlist, so a tester can use the app without a KYC step. The',
          '# keeper account is the permission manager\'s whitelister. Refused',
          '# outright on mainnet.',
          `HV_OPEN_ALLOWLIST=${args['open-allowlist'] === false ? '0' : '1'}`,
          '',
        ]
      : []),
    `HV_MAX_FEE_BPS=${MAX_FEE_BPS}`,
    `HV_RETURN_VALUE=${returnValue}`,
    `PROVER_ENDPOINT=${args.prover || process.env.PROVER_ENDPOINT || ''}`,
    `VEIL_MASTER_ACCOUNT_ADDRESS=${app.prover.masterAddress}`,
    `HV_INTAKE_PORT=${args['intake-port'] ?? 8787}`,
    '',
  ].join('\n');
  fs.writeFileSync(envFile, env, { mode: 0o600 });
  done('written', envFile);
  done('keeper account', d.wired.keeperSn || 'NOT SET — run wire.js with --keeper-sn');

  step(3, 3, 'kyc: .env');
  const kycEnvFile = path.resolve(args['kyc-env'] || path.join(__dirname, '..', 'kyc', '.env'));
  if (!fs.existsSync(path.dirname(kycEnvFile))) {
    done('skipped', `${path.dirname(kycEnvFile)} does not exist`);
  } else {
    // Same rule as the keeper's: the addresses come from the deployment file,
    // and anything secret already in the file survives. The provider's own
    // credentials are not written from here: they come from registering with
    // it, and only it knows them.
    const kycPrev = readEnv(kycEnvFile);
    const kycKeep = (k, fallback = '') => kycPrev[k] || fallback;
    const kycEnv = [
      '# HyperVeil KYC service — addresses written by scripts/write-config.js.',
      '# The provider half is yours to fill in (see .env.example).',
      '',
      `SN_RPC_URL=${process.env.SN_RPC_URL || snNet.rpc}`,
      `SN_CHAIN_ID=${network_ === 'mainnet' ? 'SN_MAIN' : 'SN_SEPOLIA'}`,
      `HV_PERMISSION_MANAGER=${d.starknet.permissionManager || ''}`,
      `SN_KYC_ADDRESS=${kycKeep('SN_KYC_ADDRESS')}`,
      `SN_KYC_PRIVATE_KEY=${kycKeep('SN_KYC_PRIVATE_KEY')}`,
      '',
      `HV_KYC_GRACE_MS=${kycKeep('HV_KYC_GRACE_MS', String(7 * 24 * 60 * 60 * 1000))}`,
      `HV_KYC_RECHECK_MS=${kycKeep('HV_KYC_RECHECK_MS', String(6 * 60 * 60 * 1000))}`,
      `HV_KYC_MAX_CHECKS=${kycKeep('HV_KYC_MAX_CHECKS', '20')}`,
      `HV_APP_ORIGIN=${kycKeep('HV_APP_ORIGIN', '*')}`,
      '',
    ].join('\n');
    fs.writeFileSync(kycEnvFile, kycEnv, { mode: 0o600 });
    done('written', kycEnvFile);
    if (!kycPrev.SN_KYC_ADDRESS) {
      done('note', 'no operator account: run kyc-operator.js once there is one');
    }
  }

  if (returnValue === '0') {
    console.log('\nWARNING: return_value is 0, so the omnibus has nothing to pay its replies with.');
    console.log('  Every CREDIT and FILL will revert with BudgetTooLow until this is a real');
    console.log('  amount of HYPE (wei), or the omnibus\'s budgets are topped up by hand');
    console.log('  (`fundBudget`). Re-run with --return-value <wei> once you know the cost.');
  }
}

try {
  main();
} catch (e) {
  console.error('\n' + String(e.message || e));
  process.exit(1);
}
