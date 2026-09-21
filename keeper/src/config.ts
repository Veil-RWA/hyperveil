// Keeper configuration, from the environment. Nothing has a production
// default: every address must be given, and the network picks the public
// Hyperliquid and Circle endpoints unless they are overridden.

import { HL_API } from "./hlApi.js";
import { IRIS_API } from "./iris.js";
import type { KeeperParams } from "./keeper.js";

export interface KeeperConfig {
  network: "mainnet" | "testnet";
  starknet: {
    rpcUrl: string;
    keeperAddress: string;
    keeperKey: string;
    pool: string;
    gateway: string;
    entryHelper: string;
    exitVault: string;
    strk: string;
    /** The pool's allowlist. Only needed with `openAllowlist`. */
    permissionManager: string;
    startBlock: number;
  };
  hyperevm: { rpcUrl: string; keeperKey: string; omnibus: string; startBlock: number };
  /** TESTNET ONLY: set when LayerZero cannot carry the messages and the keeper
   *  must (see relay.ts). Both endpoints are required together. */
  relay?: { starknetEndpoint: string; evmEndpoint: string };
  hlApiUrl: string;
  irisApiUrl: string;
  proverEndpoint?: string;
  /** The account the prover submits settles from. Without it every proven
   *  action (crossing, applying a fill) dies with "no master account
   *  configured" — the same value the app and veilx carry. */
  proverMaster?: string;
  /** TESTNET ONLY: anyone who asks the intake is put on the pool's allowlist,
   *  so a tester can use the app without a KYC step. Refused on mainnet. */
  openAllowlist: boolean;
  params: KeeperParams;
  pollMs: number;
  stateFile: string;
  intakePort: number;
}

/** `HV_OPEN_ALLOWLIST=1` turns the whole KYC gate into a formality, so it is
 *  refused outright on mainnet and needs the permission manager's address. */
function openAllowlist(env: NodeJS.ProcessEnv, network: string): boolean {
  if (env.HV_OPEN_ALLOWLIST !== "1") return false;
  if (network === "mainnet") throw new Error("HV_OPEN_ALLOWLIST is testnet only");
  if (!env.HV_PERMISSION_MANAGER) throw new Error("HV_OPEN_ALLOWLIST needs HV_PERMISSION_MANAGER");
  return true;
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

// Starknet STRK (same address on mainnet and Sepolia).
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const network = (env.HV_NETWORK ?? "testnet") as "mainnet" | "testnet";
  if (network !== "mainnet" && network !== "testnet") throw new Error("HV_NETWORK must be mainnet or testnet");
  const open = openAllowlist(env, network);
  return {
    network,
    starknet: {
      rpcUrl: need(env, "SN_RPC_URL"),
      keeperAddress: need(env, "SN_KEEPER_ADDRESS"),
      keeperKey: need(env, "SN_KEEPER_PRIVATE_KEY"),
      pool: need(env, "VEIL_POOL"),
      gateway: need(env, "HV_GATEWAY"),
      entryHelper: need(env, "HV_ENTRY_HELPER"),
      exitVault: need(env, "HV_EXIT_VAULT"),
      strk: env.SN_STRK ?? STRK,
      permissionManager: env.HV_PERMISSION_MANAGER ?? "",
      startBlock: Number(env.SN_START_BLOCK ?? 0),
    },
    hyperevm: {
      rpcUrl: need(env, "EVM_RPC_URL"),
      keeperKey: need(env, "EVM_KEEPER_PRIVATE_KEY"),
      omnibus: need(env, "HV_OMNIBUS"),
      startBlock: Number(env.EVM_START_BLOCK ?? 0),
    },
    relay: env.HV_RELAY === "1"
      ? {
          starknetEndpoint: need(env, "HV_SN_RELAY_ENDPOINT"),
          evmEndpoint: need(env, "HV_EVM_RELAY_ENDPOINT"),
        }
      : undefined,
    hlApiUrl: env.HL_API_URL ?? HL_API[network],
    irisApiUrl: env.IRIS_API_URL ?? IRIS_API[network],
    proverEndpoint: env.PROVER_ENDPOINT,
    proverMaster: env.VEIL_MASTER_ACCOUNT_ADDRESS ?? env.PROVER_MASTER,
    openAllowlist: open,
    params: {
      // Must equal the omnibus's `maxFeeBps`, or routed orders are rejected.
      maxFeeBps: Number(env.HV_MAX_FEE_BPS ?? 10),
      // HyperCore's minimum order value: $10, in USDC wei (8 decimals).
      minNotional: BigInt(env.HV_MIN_NOTIONAL ?? 1_000_000_000),
      returnValue: BigInt(env.HV_RETURN_VALUE ?? 0),
      unknownGraceMs: Number(env.HV_UNKNOWN_GRACE_MS ?? 120_000),
      maxReceiptsPerFill: Number(env.HV_MAX_RECEIPTS ?? 16),
      maxReportItems: Number(env.HV_MAX_REPORT_ITEMS ?? 8),
      maxLogWindows: Number(env.HV_MAX_LOG_WINDOWS ?? 20),
      openAllowlist: open,
    },
    pollMs: Number(env.HV_POLL_MS ?? 5_000),
    stateFile: env.HV_STATE_FILE ?? "keeper-state.json",
    intakePort: Number(env.HV_INTAKE_PORT ?? 8787),
  };
}
