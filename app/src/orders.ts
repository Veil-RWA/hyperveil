// From the order form to a Veil DvP order. The Veil order is always a limit
// order (offer X for at least Y); how Hyperliquid runs whatever Veil cannot
// cross internally is the time-in-force the keeper receives:
//   market    -> Ioc, priced at the mid +/- the slippage cap
//   limit     -> Gtc
//   post only -> Alo

import { orderTerms, toUnits, type OrderTerms } from "veil-sdk";
import type { TwinConfig } from "./config";
import { roundPrice, type Market } from "./market";

export type Tif = 1 | 2 | 3; // Alo, Gtc, Ioc (CoreWriter encoding)
export type OrderKind = "market" | "limit" | "post";

export const TIF_OF: Record<OrderKind, Tif> = { post: 1, limit: 2, market: 3 };

/** How long an order may rest before anyone can pull it back: a market
 *  order only needs time to be crossed or routed. */
export const EXPIRY_SECS: Record<OrderKind, number> = {
  market: 60 * 60,
  limit: 30 * 24 * 60 * 60,
  post: 30 * 24 * 60 * 60,
};

/** HyperCore's minimum order value: 10 USDC. Smaller orders can still be
 *  crossed inside Veil, but never reach Hyperliquid. */
export const MIN_NOTIONAL_USDC = 10;

export interface FormInput {
  side: "buy" | "sell";
  kind: OrderKind;
  size: string;
  /** Limit price, for limit / post-only. */
  price: string;
  /** Market orders: the worst price accepted, as a fraction (0.01 = 1%). */
  slippage: number;
}

export interface Draft {
  terms: OrderTerms;
  /** The limit price the order carries. */
  price: string;
  tif: Tif;
  expiry: bigint;
  /** Quote value at the limit price, human USDC. */
  notional: number;
}

export function limitPriceFor(input: FormInput, market: Market): string {
  if (input.kind !== "market") return input.price.trim();
  const mid = Number(market.mid);
  if (!Number.isFinite(mid) || mid <= 0) throw new Error("no market price yet");
  const worst = input.side === "buy" ? mid * (1 + input.slippage) : mid * (1 - input.slippage);
  return roundPrice(worst, market.base.szDecimals, input.side === "sell");
}

export function draftOrder(
  input: FormInput,
  market: Market,
  base: TwinConfig,
  quote: TwinConfig,
  maxFeeBps: number,
  now = Math.floor(Date.now() / 1000),
): Draft {
  const price = limitPriceFor(input, market);
  // Sizes on Hyperliquid are whole lots of the base.
  toUnits(input.size, market.base.szDecimals);
  const terms = orderTerms({
    side: input.side,
    size: input.size,
    price,
    base: { address: BigInt(base.address), decimals: base.decimals },
    quote: { address: BigInt(quote.address), decimals: quote.decimals },
    maxFeeBps,
  });
  return {
    terms,
    price,
    tif: TIF_OF[input.kind],
    expiry: BigInt(now + EXPIRY_SECS[input.kind]),
    notional: Number(input.size) * Number(price),
  };
}
