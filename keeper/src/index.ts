// hyperveil-keeper: `npm start` with the environment described in
// src/config.ts (see ../README.md, "Running the keeper").

import { loadConfig } from "./config.js";
import { HyperliquidApi } from "./hlApi.js";
import { HyperEvmSide } from "./hyperevmSide.js";
import { startIntake } from "./intake.js";
import { IrisApi } from "./iris.js";
import { Keeper } from "./keeper.js";
import { Relay } from "./relay.js";
import { StarknetSide } from "./starknetSide.js";
import { emptyState, loadState, saveState, takeFinishedAllowlist } from "./store.js";

const cfg = loadConfig();
const sn = new StarknetSide(
  cfg.starknet.rpcUrl,
  cfg.starknet.keeperAddress,
  cfg.starknet.keeperKey,
  cfg.starknet.pool,
  cfg.starknet.gateway,
  cfg.starknet.entryHelper,
  cfg.starknet.exitVault,
  cfg.starknet.strk,
  cfg.starknet.permissionManager,
);
const evm = new HyperEvmSide(cfg.hyperevm.rpcUrl, cfg.hyperevm.keeperKey, cfg.hyperevm.omnibus);
const state = loadState(cfg.stateFile, () => emptyState(cfg.starknet.startBlock, cfg.hyperevm.startBlock));
const relay = cfg.relay
  ? new Relay(sn, evm, {
      starknetEndpoint: cfg.relay.starknetEndpoint,
      evmEndpoint: cfg.relay.evmEndpoint,
      starknetEid: 40500,
      evmEid: 40362,
    })
  : undefined;
const keeper = new Keeper(
  sn,
  evm,
  new HyperliquidApi(cfg.hlApiUrl),
  new IrisApi(cfg.irisApiUrl),
  Keeper.exchangeFor(sn, cfg.proverEndpoint, cfg.starknet.rpcUrl, cfg.proverMaster),
  state,
  cfg.params,
  console.log,
  relay,
);

startIntake(
  cfg.intakePort,
  async (orderId) => {
    const o = await sn.getOrder(orderId);
    return { makerCommitment: o.makerCommitment, makerRulesHash: o.makerRulesHash };
  },
  (opening) => {
    keeper.acceptOpening(opening);
    saveState(cfg.stateFile, state);
  },
  (orderId, makerSalt) => {
    const problem = keeper.requestCancel(orderId, makerSalt);
    if (!problem) saveState(cfg.stateFile, state);
    return problem;
  },
  cfg.openAllowlist
    ? async (address) => {
        if (await sn.isWhitelisted(address)) return { whitelisted: true };
        keeper.requestAllowlist(address);
        saveState(cfg.stateFile, state);
        return { whitelisted: false };
      }
    : undefined,
);
console.log(
  `hyperveil keeper on ${cfg.network}; intake on :${cfg.intakePort}` +
    `${cfg.relay ? "; RELAY MODE (no LayerZero)" : ""}` +
    `${cfg.openAllowlist ? "; OPEN ALLOWLIST (anyone who asks is let in)" : ""}`,
);

for (;;) {
  await keeper.tick();
  takeFinishedAllowlist(state);
  saveState(cfg.stateFile, state);
  await new Promise((r) => setTimeout(r, cfg.pollMs));
}
