// Hyperliquid info API (docs: "Info endpoint", "Spot"). Read-only: the keeper
// never signs a HyperCore action — the omnibus is a contract and acts through
// CoreWriter; the keeper only reads what happened and reports it.

import type { HlFill } from "./fills.js";
import type { SpotPair, TokenMeta } from "./hlMath.js";

export const HL_API = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
} as const;

export interface SpotMeta {
  tokens: Array<{ name: string; szDecimals: number; weiDecimals: number; index: number }>;
  universe: Array<{ name: string; tokens: [number, number]; index: number }>;
}

export interface OrderStatus {
  /** "unknownOid" when HyperCore has no such order (not placed yet, or
   *  CoreWriter's order was dropped before resting). */
  status: string;
  oid?: bigint;
}

export class HyperliquidApi {
  constructor(private readonly baseUrl: string) {}

  private async info<T>(body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Hyperliquid info ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  spotMeta(): Promise<SpotMeta> {
    return this.info({ type: "spotMeta" });
  }

  /** Status of `user`'s order with client order id `cloid` (128-bit). */
  async orderStatus(user: string, cloid: bigint): Promise<OrderStatus> {
    const res = await this.info<{
      status: string;
      order?: { order: { oid: number }; status: string };
    }>({ type: "orderStatus", user, oid: "0x" + cloid.toString(16).padStart(32, "0") });
    if (res.status !== "order" || !res.order) return { status: res.status };
    return { status: res.order.status, oid: BigInt(res.order.order.oid) };
  }

  /** Every fill of `user` since `startTime` (ms), paging past the endpoint's
   *  500-element limit. */
  async fillsSince(user: string, startTime: number): Promise<HlFill[]> {
    const out: HlFill[] = [];
    let from = startTime;
    for (;;) {
      const page = await this.info<HlFill[]>({ type: "userFillsByTime", user, startTime: from, aggregateByTime: false });
      out.push(...page);
      if (page.length < 500) return out;
      const last = page[page.length - 1].time;
      if (last === undefined || last <= from) return out;
      from = last;
    }
  }
}

/** Every spot pair, keyed `"<base>:<quote>"` by HyperCore token index. */
export function pairsFromSpotMeta(meta: SpotMeta): Map<string, SpotPair> {
  const tokens = new Map<number, TokenMeta>();
  for (const t of meta.tokens) {
    tokens.set(t.index, { index: BigInt(t.index), name: t.name, szDecimals: t.szDecimals, weiDecimals: t.weiDecimals });
  }
  const pairs = new Map<string, SpotPair>();
  for (const u of meta.universe) {
    const base = tokens.get(u.tokens[0]);
    const quote = tokens.get(u.tokens[1]);
    if (!base || !quote) continue;
    pairs.set(pairKey(base.index, quote.index), { spotIndex: u.index, asset: 10_000 + u.index, base, quote });
  }
  return pairs;
}

export const pairKey = (base: bigint, quote: bigint): string => `${base}:${quote}`;

/** The pair a Veil order trades on, whichever side it is. */
export function pairFor(pairs: Map<string, SpotPair>, offer: bigint, want: bigint): SpotPair | undefined {
  return pairs.get(pairKey(want, offer)) ?? pairs.get(pairKey(offer, want));
}
