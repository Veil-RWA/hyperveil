// The keeper's tick, as a Lambda. EventBridge calls this on a schedule; one
// invocation runs the same pipeline the long-running keeper runs in its loop.
//
// Two guards keep it honest:
//   * a DynamoDB lock, so two invocations never send transactions from the
//     same Starknet and HyperEVM accounts at once (nonce collisions, double
//     reports). An invocation that finds the lock held simply returns.
//   * the lock expires on its own, so a crashed or timed-out tick does not
//     wedge the keeper.
//
// Proving (crossing orders, applying fills) goes through the prover's job API,
// which the SDK polls; a tick that proves therefore runs for as long as a
// proof takes, which is why the function's timeout is minutes, not seconds.

import { loadConfig } from "../config.js";
import { HyperliquidApi } from "../hlApi.js";
import { HyperEvmSide } from "../hyperevmSide.js";
import { IrisApi } from "../iris.js";
import { Keeper } from "../keeper.js";
import { Relay } from "../relay.js";
import { StarknetSide } from "../starknetSide.js";
import { emptyState } from "../store.js";
import { DynamoStore } from "./store.js";

/** How long a tick may hold the lock. Above the function's own timeout, so a
 *  timed-out invocation cannot be overlapped by the next schedule. */
const LOCK_MS = Number(process.env.HV_LOCK_MS ?? 11 * 60 * 1000);

export async function handler(): Promise<{ ok: boolean; skipped?: string; log: string[] }> {
  const cfg = loadConfig();
  const table = process.env.HV_STATE_TABLE;
  if (!table) throw new Error("missing HV_STATE_TABLE");
  const store = new DynamoStore(table, process.env.AWS_REGION);

  if (!(await store.lock(LOCK_MS))) {
    console.log("another tick holds the lock; skipping");
    return { ok: true, skipped: "locked", log: [] };
  }

  const log: string[] = [];
  const say = (m: string) => {
    log.push(m);
    console.log(m);
  };
  try {
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
    const evm = new HyperEvmSide(cfg.hyperevm.rpcUrl, cfg.hyperevm.keeperKey, cfg.hyperevm.omnibus, {
      usdc: cfg.hyperevm.usdc,
      coreDepositWallet: cfg.hyperevm.coreDepositWallet,
    });
    const state = await store.load(() => emptyState(cfg.starknet.startBlock, cfg.hyperevm.startBlock));
    const relay = cfg.relay
      ? new Relay(
          sn, evm,
          {
            starknetEndpoint: cfg.relay.starknetEndpoint,
            evmEndpoint: cfg.relay.evmEndpoint,
            starknetEid: 40500,
            evmEid: 40362,
          },
          say,
        )
      : undefined;
    const keeper = new Keeper(
      sn,
      evm,
      new HyperliquidApi(cfg.hlApiUrl, { wallet: evm.wallet, isMainnet: cfg.network === "mainnet" }),
      new IrisApi(cfg.irisApiUrl),
      Keeper.exchangeFor(sn, cfg.proverEndpoint, cfg.starknet.rpcUrl, cfg.proverMaster),
      state,
      cfg.params,
      say,
      relay,
    );
    await keeper.tick();
    await store.save(state);
    return { ok: true, log };
  } finally {
    await store.unlock();
  }
}
