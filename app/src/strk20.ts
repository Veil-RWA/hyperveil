// The user's STRK20 side, through the wallet's STRK20 API: their private USDC
// and STRK balances there, and the one STRK20 transaction that moves some of
// it into the Veil pool (built by veil-sdk's `strk20ToVeilActions`).
//
// Everything else — fees, deposits to Hyperliquid, exits — happens inside the
// Veil pool, from notes the user already holds there.

import type { Strk20Action } from "veil-sdk";
import { settled } from "./veil";
import type { Session } from "./wallet";

/** Private STRK20 balances of `tokens` (token address -> amount). */
export async function strk20Balances(session: Session, tokens: string[]): Promise<Map<bigint, bigint>> {
  const entries = (await session.account.strk20Balances(tokens)) as Array<{ token: string; balance: string }>;
  return new Map(entries.map((e) => [BigInt(e.token), BigInt(e.balance)]));
}

/** Submits STRK20 actions as one transaction (the wallet proves and pays
 *  the network fee) and waits for it. */
export async function submit(session: Session, actions: Strk20Action[]): Promise<string> {
  const { transaction_hash } = await session.account.strk20InvokeTransaction(actions as never);
  return settled(transaction_hash);
}
