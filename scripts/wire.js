#!/usr/bin/env node
// Wire HyperVeil on both chains. Idempotent: each write is skipped when the
// chain already says the same, so it is safe to re-run after a failure.
//
//   node wire.js --keeper-evm 0x<evm keeper> --keeper-sn 0x<starknet keeper>
//                [--check]
//
// The keeper addresses are the accounts the keeper process runs as: one on
// HyperEVM (it reports fills) and one on Starknet (it is the pool's exchange
// and routes orders). Both are remembered after the first run.
//
// What this sets:
//   omnibus   peer (the gateway), keeper, entry helper, exit vault, fee bound,
//             reply gas, and the HyperCore account mode
//   gateway   twins, peer (the omnibus), keeper, entry helper, exit vault, and
//             the per-kind gas its messages ask for on HyperEVM
//   pool      the twins as allowlisted tokens, USDC and STRK as rules tokens,
//             the gateway as venue, every adapter, and the keeper as exchange
//   KYC       the contracts that must hold a token for an instant

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { hash } = require('starknet');
const { compile } = require('../evm/test/harness');
const { network, GATEWAY_GAS, OMNIBUS_GAS, MAX_FEE_BPS, EXIT_CCTP } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, evmProvider, starknetAccount, snCall,
  snSend, hex, u256, word, step, done,
} = require('./lib');
const hl = require('./hl');

const KINDS = { 1: 'DEPOSIT', 2: 'PLACE', 3: 'CANCEL', 4: 'WITHDRAW' };
const same = (a, b) => BigInt(a) === BigInt(b);


/// Is the code on chain the code in this checkout?
///
/// A Starknet class is immutable and none of these contracts is upgradeable, so
/// a source change only reaches the chain through a redeploy. Editing Cairo and
/// forgetting to `scarb build` (or building and not redeploying) leaves a pool
/// that behaves like the code of whenever it was last deployed — and the Cairo
/// tests keep passing, because `snforge` compiles from source. That cost a day:
/// the pool on Sepolia still rejected `in_token == out_token` with SAME_TOKEN
/// long after the source allowed it.
///
/// So: recompute every recorded class hash from the artifacts and complain by
/// name. It is a warning, not a refusal — wiring an older deployment is a
/// legitimate thing to do deliberately.
function assertClassesAreWhatWasBuilt(d) {
  const targets = {
    veil: path.join(__dirname, '..', '..', 'target', 'dev'),
    hyperveil: path.join(__dirname, '..', 'starknet', 'target', 'dev'),
  };
  const stale = [];
  for (const [name, recorded] of Object.entries(d.classes || {})) {
    for (const [pkg, dir] of Object.entries(targets)) {
      const file = path.join(dir, `${pkg}_${name}.contract_class.json`);
      if (!fs.existsSync(file)) continue;
      const built = hash.computeContractClassHash(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (BigInt(built) !== BigInt(recorded)) stale.push([name, recorded, built]);
      break;
    }
  }
  if (!stale.length) return;
  console.log('\nWARNING: what is deployed is not what this checkout builds.\n');
  for (const [name, recorded, built] of stale) {
    console.log(`  ${name}`);
    console.log(`    deployed ${recorded}`);
    console.log(`    built    ${built}`);
  }
  console.log('\n  Nothing here is upgradeable: the chain runs the deployed class until it is');
  console.log('  redeployed. Delete its address from the deployment file and re-run the');
  console.log('  deploy script, or ignore this if you meant to wire the older one.\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const evmNet = network(args.evm);
  const snNet = network(args.starknet);
  const d = loadDeployment(args);
  const check = Boolean(args.check);
  if (!d.starknet.gateway) throw new Error('deploy the Starknet half first');
  assertClassesAreWhatWasBuilt(d);
  // The omnibus may not exist yet (see deploy-starknet.js --no-omnibus): wire
  // everything that does not name it, and say what was left.
  const haveOmnibus = Boolean(d.evm.omnibus);
  const deferred = [];

  const keeperEvm = args['keeper-evm'] || d.wired.keeperEvm;
  const keeperSn = args['keeper-sn'] || d.wired.keeperSn;
  if (!keeperEvm || !keeperSn) {
    throw new Error('--keeper-evm 0x… and --keeper-sn 0x… are required on the first run');
  }
  d.wired.keeperEvm = ethers.getAddress(keeperEvm);
  d.wired.keeperSn = hex(keeperSn);

  const [snAddress, snKey] = requireEnv('SN_ACCOUNT_ADDRESS', 'SN_PRIVATE_KEY');
  const [evmKey] = haveOmnibus ? requireEnv('EVM_PRIVATE_KEY') : [undefined];
  const provider = haveOmnibus ? evmProvider(process.env.EVM_RPC_URL || evmNet.rpc) : undefined;
  const wallet = haveOmnibus ? new ethers.Wallet(evmKey, provider) : undefined;
  const omnibus = haveOmnibus
    ? new ethers.Contract(d.evm.omnibus, compile().HyperVeilOmnibus.abi, wallet)
    : undefined;
  const { provider: snProvider, account } = starknetAccount(
    process.env.SN_RPC_URL || snNet.rpc, snAddress, snKey,
  );

  const pool = d.starknet.pool;
  const gateway = d.starknet.gateway;
  const pm = d.starknet.permissionManager;
  const twins = Object.entries(d.twins);

  console.log(`omnibus      ${haveOmnibus ? d.evm.omnibus : 'NOT DEPLOYED YET'} (${args.evm})`);
  console.log(`gateway      ${gateway} (${args.starknet})`);
  console.log(`pool         ${pool}`);
  console.log(`keeper       ${d.wired.keeperEvm} / ${d.wired.keeperSn}`);

  const pending = [];
  const evmDo = async (label, fn) => {
    if (check) {
      pending.push(label);
      return;
    }
    const tx = await fn();
    await tx.wait();
    done(label, tx.hash, `${evmNet.explorer}/tx/${tx.hash}`);
  };
  const snDo = async (label, contract, entrypoint, calldata) => {
    if (check) {
      pending.push(label);
      return;
    }
    await snSend(account, snProvider, label, contract, entrypoint, calldata, snNet.explorer);
  };

  // ── 1. The omnibus ────────────────────────────────────────────────────────
  step(1, 5, 'omnibus (HyperEVM)');
  let onCore = false;
  if (!haveOmnibus) {
    done('skipped', 'no omnibus yet: deploy it, then re-run this script');
    deferred.push('the whole omnibus side, and the gateway\'s peer');
  } else {
  const gatewayWord = word(gateway);
  if (same(await omnibus.peers(d.starknetEid), gatewayWord)) done('peer', 'set');
  else await evmDo('setPeer', () => omnibus.setPeer(d.starknetEid, gatewayWord));

  if (same(await omnibus.keeper(), d.wired.keeperEvm)) done('keeper', 'set');
  else await evmDo('setKeeper', () => omnibus.setKeeper(d.wired.keeperEvm));

  const helperWord = word(d.starknet.entryHelper);
  if (same(await omnibus.entryHelper(), helperWord)) done('entry helper', 'set');
  else await evmDo('setEntryHelper', () => omnibus.setEntryHelper(helperWord));

  const vaultWord = word(d.starknet.exitVault);
  if (same(await omnibus.exitVault(), vaultWord)) done('exit vault', 'set');
  else await evmDo('setExitVault', () => omnibus.setExitVault(vaultWord));

  if (Number(await omnibus.maxFeeBps()) === MAX_FEE_BPS) done('maxFeeBps', String(MAX_FEE_BPS));
  else await evmDo('setMaxFeeBps', () => omnibus.setMaxFeeBps(MAX_FEE_BPS));

  // The return leg's CCTP terms. Standard finality would hold an exit for
  // hours; the vault credits whatever arrives, so the cap only has to be high
  // enough that the burn is never refused.
  const [exitFee, exitFinality] = await Promise.all([
    omnibus.exitCctpMaxFee(), omnibus.exitMinFinality(),
  ]);
  if (exitFee === EXIT_CCTP.maxFee && Number(exitFinality) === EXIT_CCTP.minFinality) {
    done('exit CCTP', `fast (${EXIT_CCTP.minFinality}), cap ${EXIT_CCTP.maxFee}`);
  } else {
    await evmDo('setExitCctp', () => omnibus.setExitCctp(EXIT_CCTP.maxFee, EXIT_CCTP.minFinality));
  }

  const [credit, fillBase, fillPerItem] = await Promise.all([
    omnibus.creditGas(), omnibus.fillGas(), omnibus.fillGasPerItem(),
  ]);
  if (credit === OMNIBUS_GAS.credit && fillBase === OMNIBUS_GAS.fillBase && fillPerItem === OMNIBUS_GAS.fillPerItem) {
    done('reply gas', `${OMNIBUS_GAS.credit} / ${OMNIBUS_GAS.fillBase} + ${OMNIBUS_GAS.fillPerItem} (Starknet L2 gas)`);
  } else {
    await evmDo('setGas', () => omnibus.setGas(OMNIBUS_GAS.credit, OMNIBUS_GAS.fillBase, OMNIBUS_GAS.fillPerItem));
  }

  // The account mode is a CoreWriter action: it is dropped unless the
  // omnibus's HyperCore account exists, so it is attempted only then.
  onCore = await hl.coreUserExists(provider, d.evm.omnibus);
  if (!onCore) {
    done('HyperCore account', 'MISSING — activate it, then re-run (see below)');
  } else if (d.wired.abstraction === 1) {
    done('account mode', 'standard (1)');
  } else {
    // 1 = standard: no unified-account cap of 50k actions a day.
    await evmDo('setAbstraction(1)', () => omnibus.setAbstraction(1));
    d.wired.abstraction = 1;
  }
  }

  // ── 2. The gateway ────────────────────────────────────────────────────────
  step(2, 5, 'gateway (Starknet)');
  for (const [name, t] of twins) {
    const current = (await snCall(snProvider, gateway, 'twin_of', [String(t.hlToken)]))[0];
    if (same(current, t.address)) done(`twin ${name}`, 'set');
    else await snDo(`set_twin ${name}`, gateway, 'set_twin', [String(t.hlToken), t.address]);
  }
  if (!haveOmnibus) {
    done('peer', 'deferred: needs the omnibus address');
  } else {
    const peer = await snCall(snProvider, gateway, 'get_peer', [String(d.evmEid)]);
    const peerValue = BigInt(peer[0] ?? 0) + (BigInt(peer[1] ?? 0) << 128n);
    if (same(peerValue || 0n, d.evm.omnibus)) done('peer', 'set');
    else await snDo('set_peer', gateway, 'set_peer', [String(d.evmEid), ...u256(d.evm.omnibus)]);
  }

  const checks = [
    ['keeper', 'keeper', 'set_keeper', d.wired.keeperSn],
    ['entry helper', 'entry_helper', 'set_entry_helper', d.starknet.entryHelper],
    ['exit vault', 'exit_vault', 'set_exit_vault', d.starknet.exitVault],
  ];
  for (const [label, getter, setter, value] of checks) {
    if (!value) {
      done(label, 'deferred: not deployed yet');
      deferred.push(label);
      continue;
    }
    const current = (await snCall(snProvider, gateway, getter))[0];
    if (same(current, value)) done(label, 'set');
    else await snDo(setter, gateway, setter, [value]);
  }
  for (const [kind, gas] of Object.entries(GATEWAY_GAS)) {
    const current = (await snCall(snProvider, gateway, 'get_gas', [kind]))[0];
    if (BigInt(current) === gas) done(`gas ${KINDS[kind]}`, String(gas));
    else await snDo(`set_gas ${KINDS[kind]}`, gateway, 'set_gas', [kind, String(gas)]);
  }

  // ── 3. The pool ───────────────────────────────────────────────────────────
  step(3, 5, 'pool (Starknet)');
  const KIND_ALLOWLIST = 2;
  const KIND_RULES = 3;
  for (const [name, t] of twins) {
    const kind = Number((await snCall(snProvider, pool, 'get_token_kind', [t.address]))[0]);
    if (kind === KIND_ALLOWLIST) done(`token ${name}`, 'allowlisted');
    else await snDo(`add_allowlisted_token ${name}`, pool, 'add_allowlisted_token', [t.address, pm, '0']);
  }
  for (const [label, token, rules] of [
    ['USDC', d.starknet.usdc, d.starknet.usdcRules],
    ['STRK', d.starknet.strk, d.starknet.strkRules],
  ]) {
    const kind = Number((await snCall(snProvider, pool, 'get_token_kind', [token]))[0]);
    if (kind === KIND_RULES) done(`token ${label}`, 'rules token');
    else await snDo(`add_rules_token ${label}`, pool, 'add_rules_token', [token, rules]);
  }
  const venue = (await snCall(snProvider, pool, 'get_venue'))[0];
  if (same(venue, gateway)) done('venue', 'set');
  else await snDo('set_venue', pool, 'set_venue', [gateway]);

  const adapters = [
    ['gateway', gateway],
    ['fee adapter', d.starknet.feeAdapter],
    ...(d.starknet.entryHelper ? [['entry helper', d.starknet.entryHelper]] : []),
    ...(d.starknet.exitVault ? [['exit vault', d.starknet.exitVault]] : []),
    ...(d.starknet.strk20Entry ? [['strk20 entry', d.starknet.strk20Entry]] : []),
  ];
  for (const [label, address] of adapters) {
    const allowed = (await snCall(snProvider, pool, 'is_adapter_allowed', [address]))[0];
    if (BigInt(allowed) === 1n) done(`adapter ${label}`, 'allowed');
    else await snDo(`set_adapter_allowed ${label}`, pool, 'set_adapter_allowed', [address, '1']);
  }
  // The pool has no exchange getter, so this one is written every run.
  if (d.wired.exchange && same(d.wired.exchange, d.wired.keeperSn)) {
    done('exchange', 'set');
  } else {
    await snDo('set_exchange', pool, 'set_exchange', [d.wired.keeperSn]);
    d.wired.exchange = d.wired.keeperSn;
  }

  // ── 4. KYC ────────────────────────────────────────────────────────────────
  step(4, 5, 'KYC list (the contracts that must hold a token for an instant)');
  // The pool holds every token; the gateway, entry helper and fee adapter are
  // paid one for the length of a call. The exit vault and the STRK20 entry
  // only fill open notes, which needs no whitelisting.
  const holders = [
    ['pool', pool],
    ['gateway', gateway],
    ['fee adapter', d.starknet.feeAdapter],
    ...(d.starknet.entryHelper ? [['entry helper', d.starknet.entryHelper]] : []),
  ];
  const missing = [];
  for (const [label, address] of holders) {
    const ok = (await snCall(snProvider, pm, 'is_whitelisted', [address]))[0];
    if (BigInt(ok) === 1n) done(label, 'whitelisted');
    else missing.push([label, address]);
  }
  if (missing.length) {
    await snDo(`whitelist ${missing.map(([l]) => l).join(', ')}`, pm, 'whitelist', [
      String(missing.length), ...missing.map(([, a]) => a),
    ]);
  }

  // ── 5. Record ─────────────────────────────────────────────────────────────
  step(5, 5, 'record');
  if (check) {
    if (pending.length) {
      console.log(`\nNOT wired: ${pending.join(', ')}`);
      process.exit(1);
    }
    console.log('\neverything is wired as stated.');
    return;
  }
  d.wired.at = new Date().toISOString();
  const file = saveDeployment(args, d);
  done('written', file);
  if (deferred.length) {
    console.log(`\n  DEFERRED (re-run after deploy-hyperevm.js): ${deferred.join('; ')}`);
  }

  console.log('\nnext:');
  console.log('  node configure-dvns.js     # pin who verifies the messages');
  console.log('  node write-config.js       # app/public/deployment.json + the keeper env');
  if (haveOmnibus && !onCore) {
    console.log('\nBEFORE ANYTHING TRADES: the omnibus has no HyperCore account.');
    console.log(`  Send it USDC on HyperCore (spot send) at ${args.evm.endsWith('mainnet') ? 'app.hyperliquid.xyz' : 'app.hyperliquid-testnet.xyz'}:`);
    console.log(`    ${d.evm.omnibus}`);
    console.log('  then re-run: node wire.js   (it sets the account mode)');
  }
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
