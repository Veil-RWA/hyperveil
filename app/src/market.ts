// Hyperliquid spot market data, read straight from the public info API (it
// answers browsers: `access-control-allow-origin: *`). Nothing here signs.
//
// A spot pair's API coin is its universe `name`: "PURR/USDC" for the first
// pair, "@<index>" for every other. Its order asset id is 10000 + index.

import { toUnits } from "veil-sdk";

export interface SpotToken {
  name: string;
  index: number;
  szDecimals: number;
  weiDecimals: number;
}

export interface Market {
  /** Index in `spotMeta.universe`. */
  index: number;
  /** API coin id ("@107", "PURR/USDC"). */
  coin: string;
  /** Order asset id. */
  asset: number;
  /** "HYPE/USDC". */
  label: string;
  base: SpotToken;
  quote: SpotToken;
  mid?: string;
  prevDayPx?: string;
  dayNtlVlm?: number;
}

export interface BookLevel {
  px: string;
  sz: string;
  n: number;
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
  time: number;
}

export interface Trade {
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
}

interface RawMeta {
  tokens: Array<{ name: string; index: number; szDecimals: number; weiDecimals: number }>;
  universe: Array<{ name: string; index: number; tokens: [number, number] }>;
}

interface RawCtx {
  coin: string;
  midPx: string | null;
  markPx: string;
  prevDayPx: string;
  dayNtlVlm: string;
}

export class HyperliquidInfo {
  constructor(private readonly baseUrl: string) {}

  private async info<T>(body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
    return (await res.json()) as T;
  }

  /** Every spot pair with its mid, previous-day price and volume. */
  async markets(): Promise<Market[]> {
    const [meta, ctxs] = await this.info<[RawMeta, RawCtx[]]>({ type: "spotMetaAndAssetCtxs" });
    const tokens = new Map(meta.tokens.map((t) => [t.index, t]));
    // The contexts are not in universe order (nor the same length): match by coin.
    const ctxOf = new Map(ctxs.map((c) => [c.coin, c]));
    const out: Market[] = [];
    meta.universe.forEach((u) => {
      const base = tokens.get(u.tokens[0]);
      const quote = tokens.get(u.tokens[1]);
      if (!base || !quote) return;
      const ctx = ctxOf.get(u.name);
      out.push({
        index: u.index,
        coin: u.name,
        asset: 10_000 + u.index,
        label: `${base.name}/${quote.name}`,
        base,
        quote,
        mid: ctx?.midPx ?? ctx?.markPx ?? undefined,
        prevDayPx: ctx?.prevDayPx,
        dayNtlVlm: ctx ? Number(ctx.dayNtlVlm) : undefined,
      });
    });
    return out;
  }

  async book(coin: string): Promise<Book> {
    const r = await this.info<{ time: number; levels: [BookLevel[], BookLevel[]] }>({ type: "l2Book", coin });
    return { bids: r.levels[0] ?? [], asks: r.levels[1] ?? [], time: r.time };
  }

  async trades(coin: string): Promise<Trade[]> {
    return this.info<Trade[]>({ type: "recentTrades", coin });
  }
}

// ── Tick and lot rules (docs, "Tick and lot size"; mirror of keeper/src/hlMath.ts)

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** The price step at `px1e8` (1e8 fixed point) for a base with `szDecimals`:
 *  5 significant figures, at most 8 - szDecimals decimals, integers valid. */
export function tickStep(px1e8: bigint, szDecimals: number): bigint {
  if (px1e8 <= 0n) throw new Error("price must be positive");
  const minStep = pow10(szDecimals);
  const intDigits = px1e8.toString().length - 8;
  const sigStepExp = intDigits - 5 + 8;
  let step = sigStepExp <= 0 ? 1n : pow10(sigStepExp);
  if (step > 10n ** 8n) step = 10n ** 8n;
  return step > minStep ? step : minStep;
}

/** Why `price` is not a valid Hyperliquid price for this base, or null. */
export function priceProblem(price: string, szDecimals: number): string | null {
  let px: bigint;
  try {
    px = toUnits(price, 8);
  } catch {
    return "enter a price";
  }
  if (px === 0n) return "price must be positive";
  const step = tickStep(px, szDecimals);
  if (px % step !== 0n) return "at most 5 significant figures and " + (8 - szDecimals) + " decimals";
  return null;
}

/** Why `size` is not a whole number of lots, or null. */
export function sizeProblem(size: string, szDecimals: number): string | null {
  try {
    const sz = toUnits(size, szDecimals);
    return sz === 0n ? "size must be positive" : null;
  } catch {
    return `at most ${szDecimals} decimals`;
  }
}

/** A human price rounded to a valid tick, as a decimal string: down for a
 *  buy and up for a sell, so a slippage cap never widens. */
export function roundPrice(human: number, szDecimals: number, up: boolean): string {
  const px = BigInt(Math.max(1, Math.round(human * 1e8)));
  const step = tickStep(px, szDecimals);
  const rounded = up ? ((px + step - 1n) / step) * step : (px / step) * step;
  const whole = rounded / 10n ** 8n;
  const frac = (rounded % 10n ** 8n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
