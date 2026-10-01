// The price chart's data: Hyperliquid's candles as chart bars, prices at
// Hyperliquid's own precision, and only the candles for what is on screen.

import assert from "node:assert/strict";
import { test } from "node:test";
import { candlesFor, priceDecimals, toBars, wsUrl, type HlCandle } from "../src/chartData.ts";

const candle = (over: Partial<HlCandle> = {}): HlCandle => ({
  t: 1790814600000, T: 1790814659999, s: "@107", i: "1m",
  o: "90.216", c: "90.185", h: "90.3", l: "90.1", v: "110.76", n: 22,
  ...over,
});

test("a candle becomes a bar keyed by its open time, in seconds", () => {
  const { bar, volume } = toBars(candle());
  assert.deepEqual(bar, { time: 1790814600, open: 90.216, high: 90.3, low: 90.1, close: 90.185 });
  assert.equal(volume.time, 1790814600);
  assert.equal(volume.value, 110.76);
});

test("volume takes the candle's direction", () => {
  assert.notEqual(toBars(candle({ o: "1", c: "2" })).volume.color, toBars(candle({ o: "2", c: "1" })).volume.color);
});

test("prices show five significant figures, capped at 8 - szDecimals decimals", () => {
  assert.equal(priceDecimals(90.185, 2), 3); // HYPE: 90.185
  assert.equal(priceDecimals(29.4, 2), 3);
  assert.equal(priceDecimals(0.012345, 0), 6); // 0.012345
  assert.equal(priceDecimals(0.0001234, 2), 6); // capped by szDecimals
  assert.equal(priceDecimals(65000, 5), 0);
  assert.equal(priceDecimals(0, 2), 2); // no price yet
});

test("the websocket sits next to the info API", () => {
  assert.equal(wsUrl("https://api.hyperliquid.xyz"), "wss://api.hyperliquid.xyz/ws");
  assert.equal(wsUrl("https://api.hyperliquid-testnet.xyz/"), "wss://api.hyperliquid-testnet.xyz/ws");
});

test("only candles for the pair and interval on screen are taken", () => {
  const msg = { channel: "candle", data: candle() };
  assert.equal(candlesFor(msg, "@107", "1m").length, 1);
  assert.equal(candlesFor(msg, "@107", "15m").length, 0); // late, from the previous interval
  assert.equal(candlesFor(msg, "@1035", "1m").length, 0); // late, from the previous pair
  assert.equal(candlesFor({ channel: "candle", data: [candle(), candle({ t: 1790814660000 })] }, "@107", "1m").length, 2);
  assert.equal(candlesFor({ channel: "subscriptionResponse", data: {} }, "@107", "1m").length, 0);
  assert.equal(candlesFor({ channel: "pong" }, "@107", "1m").length, 0);
});
