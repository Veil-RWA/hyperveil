// The keeper's memory: maker openings handed over off-chain, and what it has
// seen and done on both chains. One JSON file, rewritten after every tick, so
// a restarted keeper resumes where it stopped. Everything in it can be rebuilt
// from the chains except the openings — those only the makers have.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SenderBalanceRules } from "veil-sdk";
import type { Tif } from "./hlMath.js";

/** What a maker hands the exchange for one order: who they are (the pool
 *  stores only a commitment), their balance-rules snapshot, and how the order
 *  should run on Hyperliquid if Veil cannot cross it. */
export interface Opening {
  orderId: bigint;
  maker: bigint;
  makerSalt: bigint;
  makerRules: SenderBalanceRules;
  tif: Tif;
  receivedAt: number;
  /** The maker asked to pull the order back from Hyperliquid. */
  cancelRequested?: boolean;
}

export interface RouteState {
  orderId: bigint;
  cloid: bigint;
  isBuy: boolean;
  base: bigint;
  quote: bigint;
  placedAt: number;
  reported: { cumDraw: bigint; cumDeliver: bigint };
  closedReported: boolean;
}

/** TESTNET ONLY: an address waiting to be put on the pool's allowlist.
 *  The intake records the request; the tick is what sends the transaction, so
 *  the keeper keeps exactly one writer on its Starknet account. */
export interface AllowlistRequest {
  requestedAt: number;
  /** Set by the tick once the address is on the list. The store then drops it. */
  done?: boolean;
  /** Why the last attempt failed, if it did. It is retried next tick. */
  error?: string;
}

export interface DepositState {
  burnTx: string;
  /** burned: waiting for Circle's attestation.
   *  relayed: minted to the keeper on HyperEVM (`amount6`).
   *  bridging: sent into the keeper's HyperCore account, which held
   *    `baseline8` just before; arrived once it holds `baseline8 + amount`.
   *  sent: spot-sent to the omnibus.
   *  credited: the omnibus credited the twin. */
  stage: "burned" | "relayed" | "bridging" | "sent" | "credited";
  /** What Circle minted, 6 dp (a decimal string: the state is JSON). */
  amount6?: string;
  /** The keeper's HyperCore USDC (8 dp) just before this deposit went in. */
  baseline8?: string;
}

export interface ExitState {
  stage: "requested" | "burned" | "funded" | "delivered";
  burnTx?: string;
}

export interface KeeperState {
  snBlock: number;
  evmBlock: number;
  /** TESTNET ONLY: what the relay has carried (see relay.ts). */
  relay?: { snNonce: number; evmNonce: number; snBlock: number; evmBlock: number };
  orders: Record<string, { postedAt: number }>;
  openings: Record<string, Opening>;
  /** TESTNET ONLY (HV_OPEN_ALLOWLIST), keyed by address like `openings`. */
  allowlist: Record<string, AllowlistRequest>;
  routes: Record<string, RouteState>;
  receipts: Record<string, { orderId: bigint; applied: boolean }>;
  deposits: Record<string, DepositState>;
  exits: Record<string, ExitState>;
}

export const key = (v: bigint): string => "0x" + v.toString(16);

export function emptyState(snBlock: number, evmBlock: number): KeeperState {
  return { snBlock, evmBlock, orders: {}, openings: {}, allowlist: {}, routes: {}, receipts: {}, deposits: {}, exits: {} };
}

// BigInts round-trip as {"$big": "0x.."}.
const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? { $big: "0x" + v.toString(16) } : v);
const reviver = (_: string, v: unknown) =>
  v && typeof v === "object" && "$big" in (v as Record<string, unknown>) ? BigInt((v as { $big: string }).$big) : v;

/** The state as JSON, bigints included. Used by the file store and by the
 *  DynamoDB store the Lambda deployment uses. */
export const serializeState = (state: KeeperState): string => JSON.stringify(state, replacer, 2);

export const parseState = (json: string): KeeperState => {
  const state = JSON.parse(json, reviver) as KeeperState;
  // Written before the allowlist existed.
  state.allowlist ??= {};
  return state;
};

/** One allowlist request, serialized on its own — same reason as an opening. */
export const serializeRequest = (r: AllowlistRequest): string => JSON.stringify(r, replacer);

export const parseRequest = (json: string): AllowlistRequest => JSON.parse(json, reviver) as AllowlistRequest;

/** One opening, serialized on its own — the Lambda intake writes these
 *  individually so it never rewrites what a running tick owns. */
export const serializeOpening = (o: Opening): string => JSON.stringify(o, replacer);

export const parseOpening = (json: string): Opening => JSON.parse(json, reviver) as Opening;

/** Requests the tick has finished with. Both stores call this before writing:
 *  the state file would otherwise keep every tester forever, and the DynamoDB
 *  store deletes the matching items in the same breath. */
export function takeFinishedAllowlist(state: KeeperState): string[] {
  const done = Object.entries(state.allowlist ?? {}).filter(([, r]) => r.done).map(([k]) => k);
  for (const k of done) delete state.allowlist[k];
  return done;
}

export function loadState(file: string, fresh: () => KeeperState): KeeperState {
  if (!existsSync(file)) return fresh();
  return parseState(readFileSync(file, "utf8"));
}

export function saveState(file: string, state: KeeperState): void {
  const tmp = file + ".tmp";
  writeFileSync(tmp, serializeState(state));
  renameSync(tmp, file);
}
