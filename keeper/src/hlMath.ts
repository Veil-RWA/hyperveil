// Veil order -> Hyperliquid spot order, in exact integer arithmetic.
//
// A Veil DvP order is symmetric: offer `offerAmount` of one token for at least
// `wantAmount` of another. On HyperCore the same order is a limit order on the
// spot book whose base and quote are those two tokens. This module picks the
// HyperCore price and size so that EVERY fill the order can produce respects
// the Veil order — the same inequalities the omnibus's `checkPlace` enforces
// on-chain (contracts/HyperVeilOmnibus.sol), restated here so the keeper never
// sends a PLACE the omnibus will reject.
//
// Units:
//  - amounts are HyperCore wei (a twin's unit), `weiDecimals` per token;
//  - `px` and `sz` are CoreWriter fixed point: 10^8 x the human value.
//
// Hyperliquid's tick and lot rules (docs, "Tick and lot size"): sizes are
// multiples of 10^-szDecimals; spot prices have at most 5 significant figures
// and at most 8 - szDecimals decimals, and integer prices are always allowed.

export const SCALE = 10n ** 8n;
export const BPS = 10_000n;

export interface TokenMeta {
  index: bigint;
  name: string;
  szDecimals: number;
  weiDecimals: number;
}

export interface SpotPair {
  /** Index in `spotMeta.universe`. */
  spotIndex: number;
  /** Order asset id: 10000 + spotIndex. */
  asset: number;
  base: TokenMeta;
  quote: TokenMeta;
}

export interface VeilOrderTerms {
  offerToken: bigint;
  wantToken: bigint;
  offerAmount: bigint;
  wantAmount: bigint;
  /** What would leave the pool if routed now (`escrow_remaining`). */
  escrow: bigint;
}

export type Tif = 1 | 2 | 3; // Alo, Gtc, Ioc — CoreWriter's encoding

export interface HlOrder {
  asset: number;
  isBuy: boolean;
  px: bigint;
  sz: bigint;
  tif: Tif;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Number of digits of a positive integer. */
function digits(n: bigint): number {
  return n.toString().length;
}

/** The price step, in 1e8 units, at `px1e8` for a token with `szDecimals`. */
export function tickStep(px1e8: bigint, szDecimals: number): bigint {
  if (px1e8 <= 0n) throw new Error("price must be positive");
  const minStep = pow10(szDecimals); // 10^-(8 - szDecimals) human
  // Integer part has k digits (k <= 0 below 1): 5 significant figures leave
  // 5 - k decimals. Integer prices are always valid, so the step never
  // exceeds 1 (1e8 units).
  const intDigits = digits(px1e8) - 8; // digits before the point, <= 0 below 1
  const sigStepExp = intDigits - 5 + 8; // exponent of the 5-sig-fig step, in 1e8 units
  let step = sigStepExp <= 0 ? 1n : pow10(sigStepExp);
  if (step > SCALE) step = SCALE;
  return step > minStep ? step : minStep;
}

export function roundPxDown(px1e8: bigint, szDecimals: number): bigint {
  const step = tickStep(px1e8, szDecimals);
  return (px1e8 / step) * step;
}

export function roundPxUp(px1e8: bigint, szDecimals: number): bigint {
  let px = ceilDiv(px1e8, tickStep(px1e8, szDecimals)) * tickStep(px1e8, szDecimals);
  // Rounding up can cross a power of ten, where the step grows; re-round.
  px = ceilDiv(px, tickStep(px, szDecimals)) * tickStep(px, szDecimals);
  return px;
}

export function isValidPx(px1e8: bigint, szDecimals: number): boolean {
  return px1e8 > 0n && px1e8 % tickStep(px1e8, szDecimals) === 0n;
}

/** Round a size (1e8 units) down to the token's lot. */
export function roundSzDown(sz1e8: bigint, szDecimals: number): bigint {
  const lot = pow10(8 - szDecimals);
  return (sz1e8 / lot) * lot;
}

/** Mirror of `HyperVeilOmnibus.checkPlace`: null if every fill of this order
 *  respects the Veil order at the worst fee, else the omnibus's reason. */
export function checkPlace(
  order: VeilOrderTerms,
  pair: SpotPair,
  hl: HlOrder,
  maxFeeBps: number,
): string | null {
  if (hl.tif < 1 || hl.tif > 3) return "TIF";
  if (hl.px === 0n || hl.sz === 0n) return "ZERO_FIELD";
  if (order.escrow === 0n || order.escrow > order.offerAmount || order.wantAmount === 0n) return "ESCROW";
  const { base, quote } = pair;
  const pairOk = hl.isBuy
    ? order.wantToken === base.index && order.offerToken === quote.index
    : order.offerToken === base.index && order.wantToken === quote.index;
  if (!pairOk) return "PAIR";
  const wb = pow10(base.weiDecimals);
  const wq = pow10(quote.weiDecimals);
  const keep = BPS - BigInt(maxFeeBps);
  if (hl.isBuy) {
    if (hl.px * hl.sz * wq > order.escrow * 10n ** 16n) return "OVER_ESCROW";
    if (hl.sz * wb > order.wantAmount * SCALE) return "OVER_WANT";
    if (hl.px * wq * order.wantAmount * BPS > wb * keep * order.offerAmount * SCALE) return "OVER_LIMIT";
  } else {
    if (hl.sz * wb > order.escrow * SCALE) return "OVER_ESCROW";
    if (wb * order.wantAmount * SCALE * BPS > hl.px * wq * keep * order.offerAmount) return "UNDER_LIMIT";
  }
  return null;
}

export type RouteDecision =
  | { ok: true; order: HlOrder }
  | { ok: false; reason: string };

/** The HyperCore order for a Veil order: the most it can buy (or sell) at the
 *  worst price its limit allows once the fee is paid. `minNotional` is
 *  HyperCore's minimum order value in quote wei (it rejects smaller orders). */
export function hlOrderFor(
  order: VeilOrderTerms,
  pair: SpotPair,
  maxFeeBps: number,
  tif: Tif,
  minNotional: bigint,
): RouteDecision {
  const { base, quote } = pair;
  const isBuy = order.wantToken === base.index && order.offerToken === quote.index;
  const isSell = order.offerToken === base.index && order.wantToken === quote.index;
  if (!isBuy && !isSell) return { ok: false, reason: "PAIR" };
  const wb = pow10(base.weiDecimals);
  const wq = pow10(quote.weiDecimals);
  const keep = BPS - BigInt(maxFeeBps);

  let px: bigint;
  let sz: bigint;
  if (isBuy) {
    // Highest price at which the base bought, net of the fee, still meets the
    // limit: px * wq * want * BPS <= wb * keep * offer * 1e8.
    const pxMax = (wb * keep * order.offerAmount * SCALE) / (wq * order.wantAmount * BPS);
    if (pxMax === 0n) return { ok: false, reason: "PRICE_TOO_SMALL" };
    px = roundPxDown(pxMax, base.szDecimals);
    // As much as the maker wants, and no more than the escrow pays for.
    const byWant = (order.wantAmount * SCALE) / wb;
    const byEscrow = (order.escrow * 10n ** 16n) / (px * wq);
    sz = roundSzDown(byWant < byEscrow ? byWant : byEscrow, base.szDecimals);
  } else {
    // Lowest price at which the quote received, net of the fee, still meets
    // the limit: wb * want * 1e8 * BPS <= px * wq * keep * offer.
    const pxMin = ceilDiv(wb * order.wantAmount * SCALE * BPS, wq * keep * order.offerAmount);
    px = roundPxUp(pxMin, base.szDecimals);
    sz = roundSzDown((order.escrow * SCALE) / wb, base.szDecimals);
  }
  if (sz === 0n) return { ok: false, reason: "SIZE_BELOW_LOT" };
  // Notional in quote wei: px * sz * wq / 1e16.
  if ((px * sz * wq) / 10n ** 16n < minNotional) return { ok: false, reason: "BELOW_MIN_NOTIONAL" };
  const hl: HlOrder = { asset: pair.asset, isBuy, px, sz, tif };
  const reason = checkPlace(order, pair, hl, maxFeeBps);
  return reason === null ? { ok: true, order: hl } : { ok: false, reason };
}

/** A human decimal string ("24.9", "-0.01") as an integer in `decimals`
 *  places. Throws if it has more precision than that. */
export function toUnits(value: string, decimals: number): bigint {
  const negative = value.startsWith("-");
  const s = negative ? value.slice(1) : value;
  const [int, frac = ""] = s.split(".");
  if (!/^\d+$/.test(int) || !/^\d*$/.test(frac)) throw new Error(`not a decimal: ${value}`);
  const trimmed = frac.replace(/0+$/, "");
  if (trimmed.length > decimals) throw new Error(`${value} has more than ${decimals} decimals`);
  const units = BigInt(int) * pow10(decimals) + BigInt(trimmed.padEnd(decimals, "0") || "0");
  return negative ? -units : units;
}
