// What the price chart draws, from what Hyperliquid sends. Pure: no DOM, no
// chart library, so it is tested on its own (test/chart.test.ts).

import type { UTCTimestamp } from "lightweight-charts";

/** The intervals offered, in Hyperliquid's own names. */
export const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export const isInterval = (v: unknown): v is Interval => INTERVALS.includes(v as Interval);

/** A candle as both the info API (`candleSnapshot`) and the websocket
 *  (`candle` channel) send it: open time in ms, prices and volume as strings. */
export interface HlCandle {
  t: number;
  T?: number;
  s?: string;
  i?: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n?: number;
}

export interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumeBar {
  time: UTCTimestamp;
  value: number;
  color: string;
}

// The app's --buy / --sell, and the same at a third of the strength for volume.
export const UP = "#86c5a4";
export const DOWN = "#dd8f86";
const UP_VOLUME = "#86c5a455";
const DOWN_VOLUME = "#dd8f8655";

/** One Hyperliquid candle as a price bar and a volume bar (chart time is in
 *  seconds; a candle is keyed by its open time). */
export function toBars(c: HlCandle): { bar: Bar; volume: VolumeBar } {
  const time = Math.floor(c.t / 1000) as UTCTimestamp;
  const open = Number(c.o);
  const close = Number(c.c);
  return {
    bar: { time, open, high: Number(c.h), low: Number(c.l), close },
    volume: { time, value: Number(c.v), color: close >= open ? UP_VOLUME : DOWN_VOLUME },
  };
}

/** The decimals Hyperliquid quotes a spot price with: five significant
 *  figures, and at most 8 - szDecimals decimals (docs, "Tick and lot size"). */
export function priceDecimals(px: number, szDecimals: number): number {
  const max = Math.max(0, 8 - szDecimals);
  if (!(px > 0)) return Math.min(2, max);
  const intDigits = Math.floor(Math.log10(px)) + 1;
  return Math.max(0, Math.min(max, 5 - intDigits));
}

/** Hyperliquid's websocket for an API base: https://api.hyperliquid.xyz →
 *  wss://api.hyperliquid.xyz/ws. */
export function wsUrl(api: string): string {
  return api.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
}

/** The candles in a websocket message for `coin` at `interval`, or none: acks,
 *  pongs and late candles from a previous subscription are dropped. */
export function candlesFor(message: unknown, coin: string, interval: Interval): HlCandle[] {
  const m = message as { channel?: string; data?: unknown };
  if (!m || m.channel !== "candle" || !m.data) return [];
  const list = (Array.isArray(m.data) ? m.data : [m.data]) as HlCandle[];
  return list.filter((c) => c && c.s === coin && c.i === interval && typeof c.t === "number");
}
