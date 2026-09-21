#!/usr/bin/env node
// Pin who verifies HyperVeil's messages, on both chains.
//
//   node configure-dvns.js [--required "LayerZero Labs"] [--optional "P2P" --threshold 1]
//                          [--evm-confirmations n] [--starknet-confirmations n]
//   node configure-dvns.js --check
//
// A LayerZero message is only as trustworthy as the DVNs that verify it: a
// compromised pathway could have the gateway mint twins the omnibus does not
// back, or the omnibus place orders Veil never escrowed. Left alone, an app
// follows LayerZero's defaults, which LayerZero can change. This replaces them
// with an explicit configuration:
//
//   * the omnibus and the gateway each make the operator their endpoint
//     delegate (the only account besides the app that may configure it);
//   * both sides pin ULN 302 as send and receive library;
//   * Starknet -> HyperEVM: the gateway's send config and the omnibus's
//     receive config name the SAME DVNs, at the Starknet confirmations;
//   * HyperEVM -> Starknet: the omnibus's send config and the gateway's
//     receive config name the same DVNs, at the HyperEVM confirmations;
//   * both send configs pin LayerZero's executor for the chain.
//
// A DVN only counts on a pathway if the same provider runs on BOTH chains. On
// the testnet pathway (HyperEVM testnet <-> Starknet Sepolia) that is
// LayerZero Labs alone; on mainnet nine providers qualify (config.js, from
// LayerZero's metadata API, 2026-09-19).

const { ethers } = require('ethers');
const { compile } = require('../evm/test/harness');
const { network, DEFAULT_DVNS } = require('./config');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, evmProvider, starknetAccount, snCall,
  snSend, step, done,
} = require('./lib');
const lz = require('./lzconfig');

const EVM_ENDPOINT_ABI = [
  'function delegates(address oapp) view returns (address)',
  'function getSendLibrary(address sender, uint32 eid) view returns (address)',
  'function isDefaultSendLibrary(address sender, uint32 eid) view returns (bool)',
  'function getReceiveLibrary(address receiver, uint32 eid) view returns (address lib, bool isDefault)',
  'function setSendLibrary(address oapp, uint32 eid, address newLib)',
  'function setReceiveLibrary(address oapp, uint32 eid, address newLib, uint256 gracePeriod)',
  'function setConfig(address oapp, address lib, tuple(uint32 eid, uint32 configType, bytes config)[] params)',
  'function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)',
];

const names = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
const hexAddr = (x) => '0x' + BigInt(x).toString(16);

/// Provider names -> addresses on both chains, refusing any provider that
/// does not run on both.
function resolveDvns(list, evmNet, snNet) {
  const evmSide = [];
  const snSide = [];
  for (const name of list) {
    if (!evmNet.dvns[name] || !snNet.dvns[name]) {
      throw new Error(`DVN "${name}" does not run on both chains. On both: ${
        Object.keys(evmNet.dvns).filter((n) => snNet.dvns[n]).join(', ')}`);
    }
    evmSide.push(evmNet.dvns[name]);
    snSide.push(snNet.dvns[name]);
  }
  return { evmSide, snSide };
}

async function main() {
  const args = parseArgs(process.argv);
  const evmNet = network(args.evm);
  const snNet = network(args.starknet);
  const d = loadDeployment(args);
  const check = Boolean(args.check);
  if (!d.evm.omnibus || !d.starknet.gateway) throw new Error('deploy both halves first');
  if (d.evm.relayEndpoint || d.starknet.relayEndpoint) {
    console.log(
      'This deployment uses the testnet relay endpoints, not LayerZero: there are no\n' +
      'DVNs to pin. The keeper carries the messages (keeper/src/relay.ts).'
    );
    return;
  }

  const stage = args.evm.endsWith('mainnet') ? 'mainnet' : 'testnet';
  const requiredNames = args.required ? names(args.required) : DEFAULT_DVNS[stage];
  const optionalNames = args.optional ? names(args.optional) : [];
  const threshold = Number(args.threshold ?? (optionalNames.length ? 1 : 0));
  const required = resolveDvns(requiredNames, evmNet, snNet);
  const optional = resolveDvns(optionalNames, evmNet, snNet);

  const [evmKey] = requireEnv('EVM_PRIVATE_KEY');
  const [snAddress, snKey] = requireEnv('SN_ACCOUNT_ADDRESS', 'SN_PRIVATE_KEY');
  const provider = evmProvider(process.env.EVM_RPC_URL || evmNet.rpc);
  const wallet = new ethers.Wallet(evmKey, provider);
  const endpoint = new ethers.Contract(evmNet.endpoint, EVM_ENDPOINT_ABI, wallet);
  const omnibus = new ethers.Contract(d.evm.omnibus, compile().HyperVeilOmnibus.abi, wallet);
  const { provider: snProvider, account } = starknetAccount(
    process.env.SN_RPC_URL || snNet.rpc, snAddress, snKey,
  );
  const gateway = d.starknet.gateway;
  const snEid = d.starknetEid;
  const evmEid = d.evmEid;

  console.log(`pathway      ${args.evm} (eid ${evmEid}) <-> ${args.starknet} (eid ${snEid})`);
  console.log(`omnibus      ${d.evm.omnibus}`);
  console.log(`gateway      ${gateway}`);
  console.log(`required     ${requiredNames.join(', ')}`);
  console.log(`optional     ${optionalNames.length ? `${optionalNames.join(', ')} (${threshold} of ${optionalNames.length})` : 'none'}`);

  // ── what is in force ──────────────────────────────────────────────────────
  step(1, check ? 1 : 6, 'effective configuration');
  const evmSendUln = lz.decodeEvmUln(await endpoint.getConfig(d.evm.omnibus, evmNet.sendLib, snEid, lz.CONFIG_TYPE_ULN));
  const evmRecvUln = lz.decodeEvmUln(await endpoint.getConfig(d.evm.omnibus, evmNet.receiveLib, snEid, lz.CONFIG_TYPE_ULN));
  const evmExec = lz.decodeEvmExecutor(await endpoint.getConfig(d.evm.omnibus, evmNet.sendLib, snEid, lz.CONFIG_TYPE_EXECUTOR));
  const snSendFelts = await snCall(snProvider, snNet.endpoint, 'get_send_config',
    [gateway, snNet.sendLib, String(evmEid), String(lz.CONFIG_TYPE_ULN)]);
  const snRecvFelts = await snCall(snProvider, snNet.endpoint, 'get_receive_config',
    [gateway, snNet.receiveLib, String(evmEid), String(lz.CONFIG_TYPE_ULN)]);
  const snExecFelts = await snCall(snProvider, snNet.endpoint, 'get_send_config',
    [gateway, snNet.sendLib, String(evmEid), String(lz.CONFIG_TYPE_EXECUTOR)]);
  // An Array<felt252> return starts with its length.
  const snSendUln = lz.decodeStarknetUln(snSendFelts.slice(1));
  const snRecvUln = lz.decodeStarknetUln(snRecvFelts.slice(1));
  const snExec = lz.decodeStarknetExecutor(snExecFelts.slice(1));

  const toStarknet = { confirmations: BigInt(args['evm-confirmations'] ?? evmSendUln.confirmations), threshold };
  const toEvm = { confirmations: BigInt(args['starknet-confirmations'] ?? snSendUln.confirmations), threshold };
  const policy = {
    evmSend: { ...toStarknet, required: required.evmSide, optional: optional.evmSide },
    snRecv: { ...toStarknet, required: required.snSide, optional: optional.snSide },
    snSend: { ...toEvm, required: required.snSide, optional: optional.snSide },
    evmRecv: { ...toEvm, required: required.evmSide, optional: optional.evmSide },
  };
  const show = (label, c) => done(label,
    `${c.confirmations} conf, required [${c.required.map(hexAddr).join(', ')}]` +
    (c.optional.length ? `, optional ${c.threshold}/[${c.optional.map(hexAddr).join(', ')}]` : ''));
  show('HyperEVM send', evmSendUln);
  show('Starknet receive', snRecvUln);
  show('Starknet send', snSendUln);
  show('HyperEVM receive', evmRecvUln);

  const [evmDelegate, evmSendLib, evmSendDefault, evmRecvLib, snDelegate, snSendLib, snRecvLib] =
    await Promise.all([
      endpoint.delegates(d.evm.omnibus),
      endpoint.getSendLibrary(d.evm.omnibus, snEid),
      endpoint.isDefaultSendLibrary(d.evm.omnibus, snEid),
      endpoint.getReceiveLibrary(d.evm.omnibus, snEid),
      snCall(snProvider, snNet.endpoint, 'get_delegate', [gateway]),
      snCall(snProvider, snNet.endpoint, 'get_send_library', [gateway, String(evmEid)]),
      snCall(snProvider, snNet.endpoint, 'get_receive_library', [gateway, String(evmEid)]),
    ]);

  const state = {
    evmDelegate: evmDelegate.toLowerCase() === wallet.address.toLowerCase(),
    evmSendLib: !evmSendDefault && BigInt(evmSendLib) === BigInt(evmNet.sendLib),
    evmRecvLib: !evmRecvLib.isDefault && BigInt(evmRecvLib.lib) === BigInt(evmNet.receiveLib),
    snDelegate: BigInt(snDelegate[0] ?? 0) === BigInt(snAddress),
    snSendLib: BigInt(snSendLib[1]) === 0n && BigInt(snSendLib[0]) === BigInt(snNet.sendLib),
    snRecvLib: BigInt(snRecvLib[1]) === 0n && BigInt(snRecvLib[0]) === BigInt(snNet.receiveLib),
    evmSend: lz.sameUln(evmSendUln, policy.evmSend),
    evmRecv: lz.sameUln(evmRecvUln, policy.evmRecv),
    snSend: lz.sameUln(snSendUln, policy.snSend),
    snRecv: lz.sameUln(snRecvUln, policy.snRecv),
    evmExec: BigInt(evmExec.executor) === BigInt(evmNet.executor),
    snExec: snExec.executor === BigInt(snNet.executor),
  };

  if (check) {
    for (const [k, v] of Object.entries(state)) done(k, v ? 'as configured' : 'NOT as configured');
    const ok = Object.values(state).every(Boolean);
    console.log(ok ? '\npathway configured as stated.' : '\npathway NOT configured — run without --check.');
    process.exit(ok ? 0 : 1);
  }

  const evmSend = async (label, promise) => {
    const tx = await promise;
    await tx.wait();
    done(label, tx.hash, `${evmNet.explorer}/tx/${tx.hash}`);
  };
  const snInvoke = (label, contract, entrypoint, calldata) =>
    snSend(account, snProvider, label, contract, entrypoint, calldata, snNet.explorer);

  // ── delegates ─────────────────────────────────────────────────────────────
  step(2, 6, 'operator as endpoint delegate on both sides');
  if (state.evmDelegate) done('HyperEVM', 'already the delegate');
  else await evmSend('omnibus.setDelegate', omnibus.setDelegate(wallet.address));
  if (state.snDelegate) done('Starknet', 'already the delegate');
  else await snInvoke('gateway.set_delegate', gateway, 'set_delegate', [snAddress]);

  // ── libraries ─────────────────────────────────────────────────────────────
  step(3, 6, 'pin ULN 302 as send and receive library');
  if (state.evmSendLib) done('HyperEVM send', 'pinned');
  else await evmSend('setSendLibrary', endpoint.setSendLibrary(d.evm.omnibus, snEid, evmNet.sendLib));
  if (state.evmRecvLib) done('HyperEVM receive', 'pinned');
  else await evmSend('setReceiveLibrary', endpoint.setReceiveLibrary(d.evm.omnibus, snEid, evmNet.receiveLib, 0));
  if (state.snSendLib) done('Starknet send', 'pinned');
  else await snInvoke('set_send_library', snNet.endpoint, 'set_send_library', [gateway, String(evmEid), snNet.sendLib]);
  if (state.snRecvLib) done('Starknet receive', 'pinned');
  else await snInvoke('set_receive_library', snNet.endpoint, 'set_receive_library', [gateway, String(evmEid), snNet.receiveLib, '0']);

  // ── HyperEVM -> Starknet ──────────────────────────────────────────────────
  step(4, 6, `HyperEVM -> Starknet: ${toStarknet.confirmations} confirmations`);
  if (state.evmSend && state.evmExec) {
    done('HyperEVM send config', 'already set');
  } else {
    await evmSend('setConfig (send)', endpoint.setConfig(d.evm.omnibus, evmNet.sendLib, [
      { eid: snEid, configType: lz.CONFIG_TYPE_ULN, config: lz.encodeEvmUln(policy.evmSend) },
      {
        eid: snEid,
        configType: lz.CONFIG_TYPE_EXECUTOR,
        config: lz.encodeEvmExecutor({ maxMessageSize: evmExec.maxMessageSize, executor: evmNet.executor }),
      },
    ]));
  }
  if (state.snRecv) {
    done('Starknet receive config', 'already set');
  } else {
    await snInvoke('set_receive_configs', snNet.endpoint, 'set_receive_configs', [
      gateway, snNet.receiveLib,
      ...lz.starknetConfigParams([
        { eid: evmEid, configType: lz.CONFIG_TYPE_ULN, config: lz.encodeStarknetUln(policy.snRecv) },
      ]),
    ]);
  }

  // ── Starknet -> HyperEVM ──────────────────────────────────────────────────
  step(5, 6, `Starknet -> HyperEVM: ${toEvm.confirmations} confirmations`);
  if (state.snSend && state.snExec) {
    done('Starknet send config', 'already set');
  } else {
    await snInvoke('set_send_configs', snNet.endpoint, 'set_send_configs', [
      gateway, snNet.sendLib,
      ...lz.starknetConfigParams([
        { eid: evmEid, configType: lz.CONFIG_TYPE_ULN, config: lz.encodeStarknetUln(policy.snSend) },
        {
          eid: evmEid,
          configType: lz.CONFIG_TYPE_EXECUTOR,
          config: lz.encodeStarknetExecutor({ maxMessageSize: snExec.maxMessageSize, executor: snNet.executor }),
        },
      ]),
    ]);
  }
  if (state.evmRecv) {
    done('HyperEVM receive config', 'already set');
  } else {
    await evmSend('setConfig (receive)', endpoint.setConfig(d.evm.omnibus, evmNet.receiveLib, [
      { eid: snEid, configType: lz.CONFIG_TYPE_ULN, config: lz.encodeEvmUln(policy.evmRecv) },
    ]));
  }

  // ── record ────────────────────────────────────────────────────────────────
  step(6, 6, 'record');
  d.wired.dvns = {
    required: requiredNames,
    optional: optionalNames,
    threshold,
    evmConfirmations: String(toStarknet.confirmations),
    starknetConfirmations: String(toEvm.confirmations),
  };
  done('written', saveDeployment(args, d));
  console.log('\nconfirm with: node configure-dvns.js --check');
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
