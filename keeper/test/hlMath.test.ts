import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  checkPlace,
  hlOrderFor,
  isValidPx,
  roundPxDown,
  roundPxUp,
  roundSzDown,
  tickStep,
  toUnits,
  type SpotPair,
  type VeilOrderTerms,
} from "../src/hlMath.js";

const USDC = { index: 0n, name: "USDC", szDecimals: 8, weiDecimals: 8 };
const HYPE = { index: 150n, name: "HYPE", szDecimals: 2, weiDecimals: 8 };
const PAIR: SpotPair = { spotIndex: 107, asset: 10107, base: HYPE, quote: USDC };
const FEE = 10;
const MIN = 10n * 10n ** 8n; // $10 in USDC wei

// 1_000 USDC for 40 HYPE (limit 25), and the mirror sell.
const BUY: VeilOrderTerms = {
  offerToken: 0n, wantToken: 150n, offerAmount: 100_000_000_000n, wantAmount: 4_000_000_000n, escrow: 100_000_000_000n,
};
const SELL: VeilOrderTerms = {
  offerToken: 150n, wantToken: 0n, offerAmount: 4_000_000_000n, wantAmount: 100_000_000_000n, escrow: 4_000_000_000n,
};

test("tick steps follow 5 significant figures, 8 - szDecimals decimals, integers always", () => {
  assert.equal(tickStep(2_490_000_000n, 2), 100_000n); // 24.9 -> 0.001
  assert.equal(tickStep(123_400n, 2), 100n); // 0.001234 -> capped at 6 decimals
  assert.equal(tickStep(123_400n, 0), 10n); // 0.001234 -> 7 decimals (5 sig figs)
  assert.equal(tickStep(1_234_560_000_000n, 2), 100_000_000n); // 12345.6 -> integer
  assert.equal(tickStep(12_345_600_000_000n, 2), 100_000_000n); // 123456 -> integer allowed
  assert.equal(tickStep(50_000_000n, 2), 1_000n); // 0.5 -> 0.00001
});

test("rounding stays on the tick grid, in the asked direction", () => {
  assert.equal(roundPxDown(2_497_512_345n, 2), 2_497_500_000n);
  assert.equal(roundPxUp(2_502_502_503n, 2), 2_502_600_000n);
  // Up across a power of ten: 99.9999 -> 100.00.
  assert.equal(roundPxUp(9_999_990_000n, 2), 10_000_000_000n);
  assert.ok(isValidPx(10_000_000_000n, 2));
  assert.ok(!isValidPx(2_497_512_345n, 2));
  assert.equal(roundSzDown(4_004_004_004n, 2), 4_004_000_000n);
});

test("decimal strings convert exactly or not at all", () => {
  assert.equal(toUnits("24.9", 8), 2_490_000_000n);
  assert.equal(toUnits("-0.0001", 8), -10_000n);
  assert.equal(toUnits("40", 2), 4_000n);
  assert.equal(toUnits("1.2300", 2), 123n);
  assert.throws(() => toUnits("1.234", 2));
  assert.throws(() => toUnits("1e5", 8));
});

test("a buy goes to HyperCore at the highest price its limit allows after the fee", () => {
  const r = hlOrderFor(BUY, PAIR, FEE, 2, MIN);
  assert.ok(r.ok);
  // 25 x (1 - 0.001) = 24.975: on the tick grid already.
  assert.deepEqual(r.order, { asset: 10107, isBuy: true, px: 2_497_500_000n, sz: 4_000_000_000n, tif: 2 });
  assert.equal(checkPlace(BUY, PAIR, r.order, FEE), null);
  // One tick higher breaks the limit.
  assert.equal(checkPlace(BUY, PAIR, { ...r.order, px: 2_497_600_000n }, FEE), "OVER_LIMIT");
});

test("a sell goes to HyperCore at the lowest price its limit allows after the fee", () => {
  const r = hlOrderFor(SELL, PAIR, FEE, 3, MIN);
  assert.ok(r.ok);
  // 25 / (1 - 0.001) = 25.025025..., rounded up to 25.026.
  assert.deepEqual(r.order, { asset: 10107, isBuy: false, px: 2_502_600_000n, sz: 4_000_000_000n, tif: 3 });
  assert.equal(checkPlace(SELL, PAIR, { ...r.order, px: 2_502_500_000n }, FEE), "UNDER_LIMIT");
});

test("a buy the escrow cannot fully pay for is sized down to what it can", () => {
  const r = hlOrderFor({ ...BUY, escrow: 50_000_000_000n }, PAIR, FEE, 2, MIN);
  assert.ok(r.ok);
  assert.equal(r.order.sz, 2_002_000_000n); // 500 / 24.975 = 20.02 HYPE
});

test("orders HyperCore would refuse are not routed", () => {
  assert.deepEqual(hlOrderFor({ ...BUY, offerToken: 7n }, PAIR, FEE, 2, MIN), { ok: false, reason: "PAIR" });
  assert.deepEqual(
    hlOrderFor({ ...SELL, offerAmount: 400_000n, wantAmount: 10_000_000n, escrow: 400_000n }, PAIR, FEE, 2, MIN),
    { ok: false, reason: "SIZE_BELOW_LOT" },
  );
  assert.deepEqual(
    hlOrderFor({ ...BUY, offerAmount: 500_000_000n, wantAmount: 20_000_000n, escrow: 500_000_000n }, PAIR, FEE, 2, MIN),
    { ok: false, reason: "BELOW_MIN_NOTIONAL" },
  );
});

// Parity with the contract: every order the keeper would send must pass the
// omnibus's own `checkPlace`, run on its real bytecode.
test("the omnibus accepts exactly what the keeper computes", async () => {
  const require = createRequire(import.meta.url);
  const { Chain_ } = require("../../evm/test/harness.js");
  const chain = await Chain_.create();
  await chain.deployAt("MockSpotInfo", "0x000000000000000000000000000000000000080b");
  await chain.deployAt("MockTokenInfo", "0x000000000000000000000000000000000000080C");
  const spotInfo = await chain.deployAt("MockSpotInfo", "0x000000000000000000000000000000000000080b");
  const tokenInfo = await chain.deployAt("MockTokenInfo", "0x000000000000000000000000000000000000080C");
  await spotInfo.call("setSpot", [107, 150n, 0n]);
  await tokenInfo.call("setToken", [150, 2, 8]);
  await tokenInfo.call("setToken", [0, 8, 8]);
  const one = "0x" + "11".repeat(20);
  const omnibus = await chain.deploy("HyperVeilOmnibus", [one, one, 30500, one, one, one]);

  let seed = 7n;
  const rand = (lo: bigint, hi: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return lo + (seed % (hi - lo));
  };
  let checked = 0;
  for (let i = 0; i < 60; i++) {
    const isBuy = i % 2 === 0;
    const base = rand(1_000_000_000n, 1_000_000_000_000n); // 10 .. 10_000 HYPE
    const quote = rand(10_000_000_000n, 5_000_000_000_000n); // 100 .. 50_000 USDC
    const order: VeilOrderTerms = isBuy
      ? { offerToken: 0n, wantToken: 150n, offerAmount: quote, wantAmount: base, escrow: quote }
      : { offerToken: 150n, wantToken: 0n, offerAmount: base, wantAmount: quote, escrow: base };
    const r = hlOrderFor(order, PAIR, FEE, 2, MIN);
    if (!r.ok) continue;
    const place = {
      routeId: "0x" + (i + 1).toString(16).padStart(64, "0"),
      cloid: BigInt(i + 1),
      asset: r.order.asset,
      isBuy: r.order.isBuy,
      px: r.order.px,
      sz: r.order.sz,
      tif: r.order.tif,
      offerToken: order.offerToken,
      wantToken: order.wantToken,
      offerAmount: order.offerAmount,
      wantAmount: order.wantAmount,
      escrow: order.escrow,
    };
    const verdict = (await omnibus.call("checkPlace", [place])).decoded[0];
    assert.equal(verdict, "0x" + "00".repeat(32), `order ${i} refused on-chain`);
    // And one tick past the limit, the contract refuses too.
    const worse = { ...place, px: isBuy ? place.px + tickStep(place.px, 2) : place.px - tickStep(place.px, 2) };
    const refused = (await omnibus.call("checkPlace", [worse])).decoded[0];
    assert.notEqual(refused, "0x" + "00".repeat(32), `order ${i}: a worse price was accepted`);
    checked++;
  }
  assert.ok(checked > 40, `only ${checked} orders exercised`);
});
