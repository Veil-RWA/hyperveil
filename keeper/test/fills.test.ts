import { strict as assert } from "node:assert";
import { test } from "node:test";
import { routeTotals, isClosed, type HlFill } from "../src/fills.js";
import type { SpotPair } from "../src/hlMath.js";

const PAIR: SpotPair = {
  spotIndex: 107,
  asset: 10107,
  base: { index: 150n, name: "HYPE", szDecimals: 2, weiDecimals: 8 },
  quote: { index: 0n, name: "USDC", szDecimals: 8, weiDecimals: 8 },
};

const fill = (over: Partial<HlFill>): HlFill => ({
  coin: "@107", px: "24.9", sz: "10", side: "B", oid: 77, fee: "0.007", feeToken: "HYPE", tid: 1, ...over,
});

test("a buy draws quote at the fill price and delivers base net of its fee", () => {
  const t = routeTotals(
    [fill({}), fill({ tid: 2, px: "24.85", sz: "2.5", fee: "0.00175" })],
    77n, true, PAIR,
  );
  // 249 + 62.125 USDC; 12.5 HYPE - 0.00875 HYPE fee.
  assert.equal(t.cumDraw, 31_112_500_000n);
  assert.equal(t.cumDeliver, 1_249_125_000n);
});

test("a sell draws base and delivers quote net of its fee", () => {
  const t = routeTotals([fill({ side: "A", px: "25.03", sz: "40", fee: "0.70084", feeToken: "USDC" })], 77n, false, PAIR);
  assert.equal(t.cumDraw, 4_000_000_000n);
  assert.equal(t.cumDeliver, 100_120_000_000n - 70_084_000n);
});

test("a maker rebate adds to what is delivered", () => {
  const t = routeTotals([fill({ fee: "-0.001" })], 77n, true, PAIR);
  assert.equal(t.cumDeliver, 1_000_100_000n);
});

test("fills are counted once, and only for their own order", () => {
  const t = routeTotals([fill({}), fill({}), fill({ oid: 78, tid: 9 })], 77n, true, PAIR);
  assert.equal(t.cumDraw, 24_900_000_000n);
});

test("a fill on the wrong side, or a fee in a third token, is an error", () => {
  assert.throws(() => routeTotals([fill({ side: "A" })], 77n, true, PAIR));
  assert.throws(() => routeTotals([fill({ feeToken: "PURR" })], 77n, true, PAIR));
});

test("only open and triggered orders can still fill", () => {
  assert.ok(!isClosed("open"));
  for (const s of ["filled", "canceled", "rejected", "selfTradeCanceled", "iocCancelRejected", "minTradeNtlRejected"]) {
    assert.ok(isClosed(s), s);
  }
});
