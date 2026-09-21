// Reads of the HyperVeil contracts on Starknet (gateway, exit vault, KYC
// permission manager) and the Veil pool's order views. Plain calls with
// hand-built calldata: the layouts are the Cairo structs' Serde order
// (hyperveil/starknet/src, src/interfaces).

import { hash, shortString } from "starknet";
import { poseidon } from "veil-sdk";
import { deployment } from "./config";
import { hex } from "./format";
import { rpc } from "./wallet";

const U128 = (1n << 128n) - 1n;
export const u256 = (v: bigint): string[] => [hex(v & U128), hex(v >> 128n)];

async function call(contractAddress: string, entrypoint: string, calldata: string[] = []): Promise<bigint[]> {
  const r = await rpc().callContract({ contractAddress, entrypoint, calldata });
  return (r as string[]).map((x) => BigInt(x));
}

const d = () => deployment().starknet;

// ── KYC ─────────────────────────────────────────────────────────────────────

/** Whether the permission manager lets `account` hold twins. Undefined when
 *  it did not answer (never read silence as "not approved"). */
export async function isWhitelisted(account: string): Promise<boolean | undefined> {
  try {
    return (await call(d().permissionManager, "is_whitelisted", [account]))[0] === 1n;
  } catch {
    return undefined;
  }
}

// ── Veil pool ───────────────────────────────────────────────────────────────

export const ORDER_OPEN = 0;
export const ORDER_FILLED = 1;
export const ORDER_CANCELLED = 2;

export interface PoolOrder {
  makerCommitment: bigint;
  offerToken: bigint;
  wantToken: bigint;
  offerAmount: bigint;
  wantAmount: bigint;
  escrowRemaining: bigint;
  received: bigint;
  receiveNoteId: bigint;
  expiry: number;
  status: number;
}

export async function poolOrder(orderId: bigint): Promise<PoolOrder> {
  // OrderRecord: maker_commitment, enc_maker (3 felts), offer_token, want_token,
  // offer_amount, want_amount, escrow_remaining, received, receive_note_id,
  // expiry, status, maker_rules_hash.
  const f = await call(d().pool, "get_order", [hex(orderId)]);
  return {
    makerCommitment: f[0],
    offerToken: f[4],
    wantToken: f[5],
    offerAmount: f[6],
    wantAmount: f[7],
    escrowRemaining: f[8],
    received: f[9],
    receiveNoteId: f[10],
    expiry: Number(f[11]),
    status: Number(f[12]),
  };
}

/** VenueRoute: routed, escrow, drawn. */
export async function venueRoute(orderId: bigint): Promise<{ routed: boolean; escrow: bigint; drawn: bigint }> {
  const f = await call(d().pool, "get_venue_route", [hex(orderId)]);
  return { routed: f[0] !== 0n, escrow: f[1], drawn: f[2] };
}

/** The registered public viewing key of `user` (0 when unregistered). */
export async function registeredViewingKey(user: string): Promise<bigint> {
  return (await call(d().pool, "get_viewing_key", [user]))[0];
}

// ── Gateway ─────────────────────────────────────────────────────────────────

export const DEPOSIT_SENT = 1;
export const DEPOSIT_CREDITED = 2;
export const DEPOSIT_QUARANTINED = 3;

export const ROUTE_OPEN = 1;
export const ROUTE_CLOSED = 2;
export const ROUTE_RELEASED = 3;

/** MessagingFee.native_fee (STRK) of a quote. */
const nativeFee = (f: bigint[]): bigint => f[0] + (f[1] << 128n);

export async function quoteDeposit(noteId: bigint, amountUsdc6: bigint, returnValue: bigint): Promise<bigint> {
  return nativeFee(await call(d().gateway, "quote_deposit", [hex(noteId), hex(amountUsdc6), hex(returnValue)]));
}

/** What routing an order to Hyperliquid will cost: one PLACE and, should it
 *  be pulled back, one CANCEL. A PLACE's price does not depend on its price
 *  and size fields (fixed-width), so any valid values quote it. */
export async function quoteRouting(orderId: bigint, asset: number, returnValue: bigint): Promise<bigint> {
  const place = nativeFee(
    await call(d().gateway, "quote_route", [hex(orderId), hex(asset), "0x1", "0x1", "0x1", "0x2", hex(returnValue)]),
  );
  const cancel = nativeFee(await call(d().gateway, "quote_cancel", [hex(orderId), hex(returnValue)]));
  return place + cancel;
}

export async function quoteExit(amount: bigint): Promise<bigint> {
  return nativeFee(await call(d().gateway, "quote_exit", [hex(amount), "0x0"]));
}

export async function orderCredit(orderId: bigint): Promise<bigint> {
  const f = await call(d().gateway, "order_credit", [hex(orderId)]);
  return f[0] + (f[1] << 128n);
}

/** STRK prepaid against `noteId` for its deposit's or exit's message. */
export async function noteCredit(noteId: bigint): Promise<bigint> {
  const f = await call(d().gateway, "note_credit", [hex(noteId)]);
  return f[0] + (f[1] << 128n);
}

export interface DepositRecord {
  noteId: bigint;
  amountUsdc6: bigint;
  credited: bigint;
  status: number;
}

export async function depositOf(depositId: bigint): Promise<DepositRecord> {
  const f = await call(d().gateway, "deposit_of", [hex(depositId)]);
  return { noteId: f[0], amountUsdc6: f[1], credited: f[2], status: Number(f[3]) };
}

export async function depositOfNote(noteId: bigint): Promise<bigint> {
  return (await call(d().gateway, "deposit_of_note", [hex(noteId)]))[0];
}

/** The gateway's id for the deposit into `noteId` (`poseidon('HV_DEPOSIT', pool, note)`). */
export function depositId(noteId: bigint): bigint {
  return poseidon([BigInt(shortString.encodeShortString("HV_DEPOSIT")), BigInt(d().pool), noteId]);
}

export interface RouteRecord {
  status: number;
  escrow: bigint;
  cumDraw: bigint;
  cumDeliver: bigint;
  pendingReceipts: number;
  cancelRequested: boolean;
}

export async function currentRoute(orderId: bigint): Promise<RouteRecord | null> {
  const routeId = (await call(d().gateway, "current_route", [hex(orderId)]))[0];
  if (routeId === 0n) return null;
  // RouteRecord: order_id, status, escrow, cum_draw, cum_deliver, seq,
  // pending_receipts, offer_twin, want_twin, cancel_requested.
  const f = await call(d().gateway, "route_of", [hex(routeId)]);
  return {
    status: Number(f[1]),
    escrow: f[2],
    cumDraw: f[3],
    cumDeliver: f[4],
    pendingReceipts: Number(f[6]),
    cancelRequested: f[9] !== 0n,
  };
}

// ── Exits ───────────────────────────────────────────────────────────────────

export const EXIT_REGISTERED = 1;
/** The USDC arrived, but the note is not filled yet (the pool refused). */
export const EXIT_FUNDED = 2;
export const EXIT_DELIVERED = 3;

export interface ExitRecord {
  /** The real-USDC open note in the pool this exit fills. */
  noteId: bigint;
  expected: bigint;
  funded: bigint;
  status: number;
}

export async function exitOf(exitId: bigint): Promise<ExitRecord> {
  const f = await call(d().exitVault, "exit_of", [hex(exitId)]);
  return { noteId: f[0], expected: f[1], funded: f[2], status: Number(f[3]) };
}

/** The exit that pays `noteId`, or 0. */
export async function exitOfNote(noteId: bigint): Promise<bigint> {
  return (await call(d().exitVault, "exit_of_note", [hex(noteId)]))[0];
}

/** The exit id the gateway's `ExitRequested` event carries in a settled
 *  exit transaction. */
export async function exitIdFromTx(txHash: string): Promise<bigint | null> {
  const receipt = (await rpc().waitForTransaction(txHash)) as unknown as {
    events?: Array<{ from_address: string; keys: string[] }>;
    value?: { events?: Array<{ from_address: string; keys: string[] }> };
  };
  const events = receipt.events ?? receipt.value?.events ?? [];
  const selector = BigInt(hash.getSelectorFromName("ExitRequested"));
  const gateway = BigInt(d().gateway);
  for (const e of events) {
    if (BigInt(e.from_address) === gateway && BigInt(e.keys[0]) === selector) return BigInt(e.keys[1]);
  }
  return null;
}

/** Exits registered for any of `noteIds` (the vault's `ExitRegistered`
 *  events): recovers exit ids when this browser has lost its records. */
export async function exitsFor(noteIds: Set<bigint>): Promise<Array<{ exitId: bigint; noteId: bigint; amount: bigint }>> {
  const out: Array<{ exitId: bigint; noteId: bigint; amount: bigint }> = [];
  const selector = hash.getSelectorFromName("ExitRegistered");
  let token: string | undefined;
  do {
    const page = await rpc().getEvents({
      address: d().exitVault,
      from_block: { block_number: d().deployBlock },
      to_block: "latest",
      keys: [[selector]],
      chunk_size: 500,
      ...(token ? { continuation_token: token } : {}),
    } as never);
    for (const e of page.events) {
      const noteId = BigInt(e.data[0]);
      if (noteIds.has(noteId)) out.push({ exitId: BigInt(e.keys[1]), noteId, amount: BigInt(e.data[1]) });
    }
    token = page.continuation_token;
  } while (token);
  return out;
}

// ── ERC-20 ──────────────────────────────────────────────────────────────────

export async function erc20Balance(token: string, account: string): Promise<bigint> {
  const f = await call(token, "balance_of", [account]);
  return f[0] + ((f[1] ?? 0n) << 128n);
}
