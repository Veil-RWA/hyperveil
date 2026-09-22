#!/usr/bin/env node
// Deploy HyperVeil's Starknet half: its own Veil pool, the KYC permission
// manager, the gateway, one twin per HyperCore token, the KYC rules that let
// real USDC and STRK sit in the pool, the entry helper, the exit vault, the
// fee adapter and the STRK20 entry.
//
//   node deploy-starknet.js [--tokens PURR,HYPE] [--auditor-key 0x...]
//                           [--starknet starknet-sepolia] [--keeper-evm 0x...]
//
// HyperVeil gets its OWN pool: a Veil pool has exactly one exchange
// (the keeper) and one venue (the gateway), so it cannot share the main pool.
// The pool comes from a factory this script deploys with the current
// VeilERC3643 class, because `create_pool` is what makes a pool recognisable
// as one.
//
// Twins are named by HyperCore ticker and resolved against the live info API,
// so a twin's decimals are always the token's `weiDecimals` — never a guess.
//
// Run `scarb build` in ../../ (the veil package) and in ../starknet first.
// Resumable: every address is written to the deployment file as it exists.

const fs = require('fs');
const path = require('path');
const { CallData, byteArray, hash, num } = require('starknet');
const { network, DEFAULT_TOKENS } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, starknetAccount, snCall, hex, u256,
  step, done,
} = require('./lib');
const hl = require('./hl');

const TARGETS = {
  veil: path.join(__dirname, '..', '..', 'target', 'dev'),
  hyperveil: path.join(__dirname, '..', 'starknet', 'target', 'dev'),
};

function artifact(pkg, contract) {
  const dir = TARGETS[pkg];
  const sierra = path.join(dir, `${pkg === 'veil' ? 'veil' : 'hyperveil'}_${contract}.contract_class.json`);
  const casm = path.join(dir, `${pkg === 'veil' ? 'veil' : 'hyperveil'}_${contract}.compiled_contract_class.json`);
  if (!fs.existsSync(sierra)) {
    throw new Error(
      `missing ${path.basename(sierra)} — run: (cd ${pkg === 'veil' ? '../..' : '../starknet'} && scarb build)`
    );
  }
  return { sierra: JSON.parse(fs.readFileSync(sierra, 'utf8')), casm: JSON.parse(fs.readFileSync(casm, 'utf8')) };
}

async function declareIfNeeded(account, d, pkg, contract) {
  const { sierra, casm } = artifact(pkg, contract);
  const classHash = hash.computeContractClassHash(sierra);
  if (d.classes[contract] === classHash) return classHash;
  const res = await account.declareIfNot({ contract: sierra, casm });
  if (res.transaction_hash) {
    console.log(`      declaring ${contract}…`);
    await account.provider.waitForTransaction(res.transaction_hash);
  }
  d.classes[contract] = classHash;
  done(`class ${contract}`, classHash);
  return classHash;
}

async function deploy(account, classHash, calldata) {
  const res = await account.deployContract({ classHash, constructorCalldata: calldata });
  await account.provider.waitForTransaction(res.transaction_hash);
  return res.contract_address;
}

async function main() {
  const args = parseArgs(process.argv);
  const net = network(args.starknet);
  const evmNet = network(args.evm);
  if (net.kind !== 'starknet') throw new Error(`${args.starknet} is not a Starknet network`);
  if (!net.usdc) throw new Error(`no USDC pinned for ${args.starknet} — fill it in scripts/config.js`);

  const [accountAddress, key] = requireEnv('SN_ACCOUNT_ADDRESS', 'SN_PRIVATE_KEY');
  const rpc = process.env.SN_RPC_URL || net.rpc;
  const { provider, account } = starknetAccount(rpc, accountAddress, key);
  const d = loadDeployment(args);
  // The entry helper and the exit vault bind the omnibus's address at
  // construction; everything else does not. `--no-omnibus` deploys the rest
  // now and leaves those two for a later run (the file is resumable).
  const deferOmnibus = Boolean(args['no-omnibus']) && !d.evm.omnibus;
  if (!d.evm.omnibus && !deferOmnibus) {
    throw new Error(
      'deploy the omnibus first (node deploy-hyperevm.js), or pass --no-omnibus\n' +
      '  to deploy everything that does not bind its address yet.'
    );
  }

  const chainId = await provider.getChainId();
  if (BigInt(chainId) !== BigInt(net.chainId)) {
    throw new Error(`${rpc} is chain ${chainId}, not ${args.starknet}`);
  }
  const tokens = await hl.resolveTokens(
    evmNet.hlApi,
    (args.tokens ? String(args.tokens).split(',') : DEFAULT_TOKENS).map((t) => t.trim()).filter(Boolean),
  );
  // The auditor key: whoever may decrypt who owns a note, in the pool's own
  // scheme. Reused across runs; a pool cannot change it after deployment.
  const auditorKey = args['auditor-key'] || d.starknet.auditorPublicKey;
  if (!auditorKey) {
    throw new Error(
      '--auditor-key 0x<stark curve x> is required on the first run (the pool has no setter for it).'
    );
  }

  console.log(`network      ${args.starknet} (eid ${net.eid})`);
  console.log(`rpc          ${rpc}`);
  console.log(`account      ${accountAddress}`);
  console.log(`omnibus      ${d.evm.omnibus ?? 'NOT DEPLOYED YET (deferring the helper and the vault)'} (eid ${d.evmEid})`);
  console.log(`tokens       ${tokens.map((t) => `${t.name}#${t.index}/${t.weiDecimals}dp`).join(', ')}`);

  const total = 9;
  d.starknet.auditorPublicKey = num.toHex(BigInt(auditorKey));
  d.starknet.usdc = net.usdc;
  d.starknet.strk = net.strk;

  // ── 1. The pool ───────────────────────────────────────────────────────────
  step(1, total, 'VeilERC3643 pool (its own: one exchange, one venue)');
  const veilClass = await declareIfNeeded(account, d, 'veil', 'VeilERC3643');
  if (!d.starknet.factory) {
    const factoryClass = await declareIfNeeded(account, d, 'veil', 'VeilERC3643Factory');
    d.starknet.factory = await deploy(account, factoryClass, [accountAddress, veilClass]);
    saveDeployment(args, d);
    done('factory', d.starknet.factory);
  } else {
    done('factory', `${d.starknet.factory} (already deployed)`);
  }
  if (!d.starknet.pool) {
    const res = await account.execute({
      contractAddress: d.starknet.factory,
      entrypoint: 'create_pool',
      calldata: [d.starknet.auditorPublicKey],
    });
    const receipt = await provider.waitForTransaction(res.transaction_hash);
    const created = hash.getSelectorFromName('PoolCreated');
    const events = receipt.events ?? receipt.value?.events ?? [];
    const event = events.find(
      (e) => BigInt(e.from_address) === BigInt(d.starknet.factory) && BigInt(e.keys[0]) === BigInt(created),
    );
    if (!event) throw new Error(`no PoolCreated event in ${res.transaction_hash}`);
    d.starknet.pool = num.toHex(BigInt(event.keys[2]));
    d.starknet.deployBlock = receipt.block_number ?? receipt.value?.block_number ?? 0;
    saveDeployment(args, d);
  }
  done('pool', d.starknet.pool, `${net.explorer}/contract/${d.starknet.pool}`);

  // ── 2. KYC ────────────────────────────────────────────────────────────────
  step(2, total, 'HyperVeilPermissionManager (the KYC list)');
  if (!d.starknet.permissionManager) {
    const cls = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilPermissionManager');
    const operator = args['kyc-operator'] || accountAddress;
    d.starknet.permissionManager = await deploy(account, cls, [accountAddress, operator]);
    d.starknet.kycOperator = operator;
    saveDeployment(args, d);
  }
  done('permission manager', d.starknet.permissionManager);

  // ── 3. Gateway ────────────────────────────────────────────────────────────
  // TESTNET ONLY: with --relay the gateway is deployed against a relay
  // endpoint the keeper drives, because LayerZero has no pathway between these
  // two testnets. The gateway is unchanged either way.
  let endpointAddress = net.endpoint;
  if (args.relay) {
    if (args.starknet.endsWith('mainnet')) throw new Error('--relay is testnet only');
    if (!d.starknet.relayEndpoint) {
      const cls = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilRelayEndpoint');
      const relayer = args['keeper-sn'] || d.wired.keeperSn || accountAddress;
      d.starknet.relayEndpoint = await deploy(account, cls, [accountAddress, relayer]);
      d.wired.keeperSn = d.wired.keeperSn || relayer;
      saveDeployment(args, d);
    }
    endpointAddress = d.starknet.relayEndpoint;
    done('relay endpoint', d.starknet.relayEndpoint);
  }
  step(3, total, 'HyperVeilGateway (LayerZero app + the pool\'s venue)');
  if (!d.starknet.gateway) {
    const cls = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilGateway');
    d.starknet.gateway = await deploy(account, cls, [
      accountAddress, endpointAddress, net.strk, String(d.evmEid), d.starknet.pool,
    ]);
    saveDeployment(args, d);
  }
  done('gateway', d.starknet.gateway, `${net.explorer}/contract/${d.starknet.gateway}`);

  // ── 4. Twins ──────────────────────────────────────────────────────────────
  step(4, total, 'HyperVeilTwin, one per HyperCore token');
  const twinClass = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilTwin');
  for (const t of tokens) {
    const slot = (d.twins[t.name] = d.twins[t.name] || {});
    slot.hlToken = t.index;
    slot.decimals = t.weiDecimals;
    slot.symbol = `hv${t.name}`;
    if (slot.address) {
      done(`${t.name} twin`, `${slot.address} (already deployed)`);
      continue;
    }
    const calldata = CallData.compile([
      byteArray.byteArrayFromString(`HyperVeil ${t.name}`),
      byteArray.byteArrayFromString(slot.symbol),
      t.weiDecimals,
      t.index,
      accountAddress,
      d.starknet.permissionManager,
      d.starknet.gateway,
    ]);
    slot.address = await deploy(account, twinClass, calldata);
    saveDeployment(args, d);
    done(`${t.name} twin`, `${slot.address} (${t.weiDecimals} dp)`);
  }

  // ── 5. KYC rules for real USDC and STRK ───────────────────────────────────
  step(5, total, 'HyperVeilKycRules for USDC and STRK (pool rules tokens)');
  const rulesClass = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilKycRules');
  if (!d.starknet.usdcRules) {
    // Circle's FiatToken: its pause and blocklist are mirrored as well.
    d.starknet.usdcRules = await deploy(account, rulesClass, [net.usdc, d.starknet.permissionManager, '1']);
    saveDeployment(args, d);
  }
  done('USDC rules', d.starknet.usdcRules);
  if (!d.starknet.strkRules) {
    d.starknet.strkRules = await deploy(account, rulesClass, [net.strk, d.starknet.permissionManager, '0']);
    saveDeployment(args, d);
  }
  done('STRK rules', d.starknet.strkRules);

  // ── 6. Entry helper ───────────────────────────────────────────────────────
  step(6, total, 'HyperVeilEntryHelper (the deposit adapter)');
  if (deferOmnibus) {
    done('deferred', 'needs the omnibus address; re-run this script after deploy-hyperevm.js');
  } else if (!d.starknet.entryHelper) {
    // Circle mints a deposit's USDC to the keeper, which spot-sends it to the
    // omnibus on HyperCore; the omnibus alone relays the mint.
    const keeperEvm = args['keeper-evm'] || d.wired.keeperEvm;
    if (!keeperEvm) throw new Error('--keeper-evm 0x… is required: deposits are minted to the keeper');
    if (!/^0x[0-9a-fA-F]{40}$/.test(keeperEvm)) throw new Error(`--keeper-evm is not an address: ${keeperEvm}`);
    d.wired.keeperEvm = keeperEvm;
    const cls = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilEntryHelper');
    d.starknet.entryHelper = await deploy(account, cls, [
      d.starknet.gateway, net.usdc, net.tokenMessenger, ...u256(d.evm.omnibus), ...u256(d.wired.keeperEvm),
    ]);
    saveDeployment(args, d);
  }
  done('entry helper', d.starknet.entryHelper);

  // ── 7. Exit vault ─────────────────────────────────────────────────────────
  step(7, total, 'HyperVeilExitVault');
  if (deferOmnibus) {
    done('deferred', 'needs the omnibus address; re-run this script after deploy-hyperevm.js');
  } else if (!d.starknet.exitVault) {
    const cls = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilExitVault');
    d.starknet.exitVault = await deploy(account, cls, [
      d.starknet.gateway, net.usdc, net.messageTransmitter, ...u256(d.evm.omnibus),
    ]);
    saveDeployment(args, d);
  }
  done('exit vault', d.starknet.exitVault);

  // ── 8. Fee adapter ────────────────────────────────────────────────────────
  step(8, total, 'HyperVeilFeeAdapter (private STRK prepays every message)');
  if (!d.starknet.feeAdapter) {
    const cls = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilFeeAdapter');
    d.starknet.feeAdapter = await deploy(account, cls, [d.starknet.gateway]);
    saveDeployment(args, d);
  }
  done('fee adapter', d.starknet.feeAdapter);

  // ── 9. STRK20 entry ───────────────────────────────────────────────────────
  step(9, total, 'HyperVeilStrk20Entry (STRK20 -> Veil)');
  const strk20Pool = args['strk20-pool'] || d.starknet.strk20Pool || process.env.STRK20_POOL;
  if (!strk20Pool) {
    done('skipped', 'no --strk20-pool given: "from STRK20" stays off in the app');
  } else if (d.starknet.strk20Entry) {
    done('strk20 entry', `${d.starknet.strk20Entry} (already deployed)`);
  } else {
    const cls = await declareIfNeeded(account, d, 'hyperveil', 'HyperVeilStrk20Entry');
    d.starknet.strk20Pool = num.toHex(BigInt(strk20Pool));
    d.starknet.strk20Entry = await deploy(account, cls, [d.starknet.strk20Pool, d.starknet.pool]);
    saveDeployment(args, d);
    done('strk20 entry', d.starknet.strk20Entry);
  }

  // The gateway's own view of the pool, as a last check that nothing is crossed.
  const poolOnGateway = (await snCall(provider, d.starknet.gateway, 'pool'))[0];
  if (BigInt(poolOnGateway) !== BigInt(d.starknet.pool)) {
    throw new Error(`the gateway points at pool ${poolOnGateway}, not ${d.starknet.pool}`);
  }

  const file = saveDeployment(args, d);
  console.log(`\nwritten to ${path.relative(process.cwd(), file)}`);
  console.log('\nnext:');
  if (deferOmnibus) {
    console.log('  node deploy-hyperevm.js   # then re-run this script to finish the two deferred');
  }
  console.log('  node wire.js          # both chains: peers, twins, adapters, the pool');
  console.log('  node configure-dvns.js');
  console.log(`  node whitelist.js --account ${accountAddress}   # KYC yourself to test`);
  void hex;
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
