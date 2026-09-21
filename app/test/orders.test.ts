// The app's order drafting and Hyperliquid tick rules. The tick rules must
// agree exactly with the keeper's (which the omnibus's checkPlace mirrors),
// or the form would accept prices the keeper then has to round.

import assert from "node:assert/strict";
import { test } from "node:test";
import { tickStep as keeperTickStep } from "../../keeper/src/hlMath.ts";
import { priceProblem, roundPrice, sizeProblem, tickStep, type Market } from "../src/market.ts";
import { EXPIRY_SECS, draftOrder, limitPriceFor } from "../src/orders.ts";

const hype: Market = {
  index: 107,
  coin: "@107",
  asset: 10_107,
  label: "HYPE/USDC",
  base: { name: "HYPE", index: 150, szDecimals: 2, weiDecimals: 8 },
  quote: { name: "USDC", index: 0, szDecimals: 8, weiDecimals: 8 },
  mid: "32.885",
};
const baseTwin = { hlToken: 150, address: "0x222", symbol: "HYPE", decimals: 8 };
const quoteTwin = { hlToken: 0, address: "0x111", symbol: "USDC", decimals: 8 };

test("tickStep matches the keeper's for every magnitude and szDecimals", () => {
  const prices = [1n, 7n, 99n, 12_345n, 99_999n, 100_000n, 1_234_567n, 3_288_500_000n, 99_999_000_000n, 123_456_789_000_000n];
  for (const px of prices) {
    for (let sz = 0; sz <= 8; sz++) {
      assert.equal(tickStep(px, sz), keeperTickStep(px, sz), `px ${px} szDecimals ${sz}`);
    }
  }
});

test("prices: five significant figures, at most 8 - szDecimals decimals", () => {
  assert.equal(priceProblem("32.885", 2), null);
  assert.match(priceProblem("32.8855", 2)!, /significant/);
  assert.equal(priceProblem("123456", 2), null); // integers are always valid
  assert.match(priceProblem("0.0000012", 4)!, /decimals/);
  assert.equal(priceProblem("0.0012", 4), null);
  assert.equal(priceProblem("abc", 2), "enter a price");
});

test("sizes are whole lots", () => {
  assert.equal(sizeProblem("1.25", 2), null);
  assert.match(sizeProblem("1.255", 2)!, /2 decimals/);
  assert.equal(sizeProblem("0", 2), "size must be positive");
});

test("slippage caps round inward: down for a buy, up for a sell", () => {
  assert.equal(roundPrice(33.21385, 2, false), "33.213");
  assert.equal(roundPrice(32.55615, 2, true), "32.557");
  for (const p of [roundPrice(33.21385, 2, false), roundPrice(32.55615, 2, true)]) assert.equal(priceProblem(p, 2), null);
});

test("a market order is a limit at mid +/- slippage and runs IOC", () => {
  const buy = limitPriceFor({ side: "buy", kind: "market", size: "1", price: "", slippage: 0.01 }, hype);
  assert.equal(buy, "33.213");
  const d = draftOrder({ side: "buy", kind: "market", size: "2", price: "", slippage: 0.01 }, hype, baseTwin, quoteTwin, 10, 1_000);
  assert.equal(d.tif, 3);
  assert.equal(d.expiry, BigInt(1_000 + EXPIRY_SECS.market));
  // Buy 2 HYPE at 33.213, leaving room for a 10 bps fee: offer ceil(66.426 / 0.999).
  assert.equal(d.terms.offerToken, 0x111n);
  assert.equal(d.terms.wantToken, 0x222n);
  assert.equal(d.terms.wantAmount, 200_000_000n);
  assert.equal(d.terms.offerAmount, (6_642_600_000n * 10_000n + 9_989n) / 9_990n);
});

test("limit and post-only orders keep the typed price", () => {
  const sell = draftOrder({ side: "sell", kind: "post", size: "1.5", price: "40", slippage: 0 }, hype, baseTwin, quoteTwin, 10, 0);
  assert.equal(sell.tif, 1);
  assert.equal(sell.price, "40");
  assert.equal(sell.terms.offerAmount, 150_000_000n);
  // Sell 1.5 at 40 = 60 USDC, minus the 10 bps headroom.
  assert.equal(sell.terms.wantAmount, 5_994_000_000n);
  const gtc = draftOrder({ side: "buy", kind: "limit", size: "1", price: "30", slippage: 0 }, hype, baseTwin, quoteTwin, 10, 0);
  assert.equal(gtc.tif, 2);
});
