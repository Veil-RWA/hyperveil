// HyperCore fills -> a route's cumulative (draw, deliver), in HyperCore wei.
//
// HyperEVM cannot read fills, so the keeper reports them; the omnibus then
// checks the report against its real balances. These totals are what goes in
// that report. Every rounding here errs the omnibus's safe way: a draw is
// never under-stated (the maker could keep escrow HyperCore already spent)
// and a delivery never over-stated (twins HyperCore does not hold).
//
// Spot fees are charged in the token received (a buyer pays in the base, a
// seller in the quote); a fill's `feeToken` says which, and a negative fee is a
// maker rebate.

import { SCALE, toUnits, type SpotPair } from "./hlMath.js";

/** One entry of the info endpoint's `userFills` / `userFillsByTime`. */
export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  oid: number | bigint;
  fee: string;
  feeToken: string;
  tid: number | bigint;
  time?: number;
}

export interface RouteTotals {
  cumDraw: bigint;
  cumDeliver: bigint;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Totals over every fill of HyperCore order `oid`. Fills are deduplicated by
 *  trade id, so overlapping pages of the fills endpoint cannot double-count. */
export function routeTotals(fills: HlFill[], oid: bigint, isBuy: boolean, pair: SpotPair): RouteTotals {
  const seen = new Set<string>();
  let draw = 0n;
  let deliver = 0n;
  const { base, quote } = pair;
  for (const f of fills) {
    if (BigInt(f.oid) !== oid) continue;
    const tid = BigInt(f.tid).toString();
    if (seen.has(tid)) continue;
    seen.add(tid);
    if ((f.side === "B") !== isBuy) throw new Error(`fill ${tid} is on the wrong side for its order`);

    const sz = toUnits(f.sz, base.szDecimals); // 10^szDecimals units
    const px = toUnits(f.px, 8); // 1e8 units
    const baseWei = sz * pow10(base.weiDecimals - base.szDecimals);
    // px * sz in quote wei: (px/1e8) * (sz/10^szd) * 10^wdq.
    const num = px * sz * pow10(quote.weiDecimals);
    const den = SCALE * pow10(base.szDecimals);
    const feeInBase = f.feeToken === base.name;
    const feeInQuote = f.feeToken === quote.name;
    if (!feeInBase && !feeInQuote) throw new Error(`fill ${tid}: fee in ${f.feeToken}, neither side`);
    const feeWei = toUnits(f.fee, feeInBase ? base.weiDecimals : quote.weiDecimals);

    if (isBuy) {
      draw += ceilDiv(num, den) + (feeInQuote ? feeWei : 0n);
      deliver += baseWei - (feeInBase ? feeWei : 0n);
    } else {
      draw += baseWei + (feeInBase ? feeWei : 0n);
      deliver += num / den - (feeInQuote ? feeWei : 0n);
    }
  }
  if (deliver < 0n) throw new Error("fees exceed what was received");
  return { cumDraw: draw, cumDeliver: deliver };
}

/** HyperCore order statuses after which nothing more can fill (docs, "Query
 *  order status by oid or cloid"). */
const OPEN_STATUSES = new Set(["open", "triggered"]);

export function isClosed(status: string): boolean {
  return !OPEN_STATUSES.has(status);
}
