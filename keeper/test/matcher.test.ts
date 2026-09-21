import { strict as assert } from "node:assert";
import { test } from "node:test";
import { crossPair, matchBook, type BookOrder } from "../src/matcher.js";

const X = 0n; // USDC
const Y = 150n; // HYPE

const order = (id: bigint, over: Partial<BookOrder>): BookOrder => ({
  orderId: id, offerToken: X, wantToken: Y, offerAmount: 0n, wantAmount: 0n, escrow: 0n, received: 0n, postedAt: Number(id), ...over,
});

// Buy 40 HYPE for up to 1_000 USDC (25/HYPE), then sell 40 HYPE for >= 960 (24/HYPE).
const BUY = order(1n, { offerAmount: 1_000n * 10n ** 8n, wantAmount: 40n * 10n ** 8n, escrow: 1_000n * 10n ** 8n });
const SELL = order(2n, {
  offerToken: Y, wantToken: X, offerAmount: 40n * 10n ** 8n, wantAmount: 960n * 10n ** 8n, escrow: 40n * 10n ** 8n,
});

function assertBatchValid(orders: BookOrder[], crosses: ReturnType<typeof matchBook>) {
  const byId = new Map(orders.map((o) => [o.orderId, { ...o }]));
  const net = new Map<bigint, bigint>();
  for (const c of crosses) {
    for (const [id, f] of [[c.older, c.olderFill], [c.newer, c.newerFill]] as const) {
      const o = byId.get(id)!;
      assert.ok(f.deliver > 0n, "zero delivery");
      assert.ok(f.draw <= o.escrow, "draw over escrow");
      assert.ok(o.received + f.deliver <= o.wantAmount, "over delivery");
      assert.ok(f.draw * o.wantAmount <= f.deliver * o.offerAmount, "limit price broken");
      o.escrow -= f.draw;
      o.received += f.deliver;
      net.set(o.offerToken, (net.get(o.offerToken) ?? 0n) + f.draw);
      net.set(o.wantToken, (net.get(o.wantToken) ?? 0n) - f.deliver);
    }
  }
  for (const [token, v] of net) assert.equal(v, 0n, `token ${token} not conserved`);
}

test("opposite orders whose limits overlap cross at the older order's price", () => {
  const c = crossPair(BUY, SELL)!;
  assert.ok(c);
  // At 25/HYPE. The pool caps a maker's delivery at its want, so the seller
  // (who asked 960 USDC) receives exactly 960 and sells only 38.4 HYPE for it:
  // its price improvement is the 1.6 HYPE it keeps in escrow.
  assert.deepEqual(c.olderFill, { deliver: 3_840_000_000n, draw: 960n * 10n ** 8n });
  assert.deepEqual(c.newerFill, { deliver: 960n * 10n ** 8n, draw: 3_840_000_000n });
  assertBatchValid([BUY, SELL], [c]);
});

test("orders whose limits do not overlap stay for Hyperliquid", () => {
  const dear = { ...SELL, wantAmount: 1_001n * 10n ** 8n };
  assert.equal(crossPair(BUY, dear), null);
  assert.equal(crossPair(BUY, { ...BUY, orderId: 3n }), null); // same side
});

test("partial liquidity crosses what it can and leaves the rest", () => {
  const smallSell = { ...SELL, offerAmount: 10n * 10n ** 8n, wantAmount: 240n * 10n ** 8n, escrow: 10n * 10n ** 8n };
  const [c] = matchBook([BUY, smallSell]);
  // The seller wants 240 USDC: at 25/HYPE that is 9.6 of its 10 HYPE.
  assert.equal(c.olderFill.deliver, 960_000_000n);
  assert.equal(c.olderFill.draw, 240n * 10n ** 8n);
  assertBatchValid([BUY, smallSell], [c]);
});

test("exactly equal limits still cross in whole units", () => {
  const a = order(1n, { offerAmount: 7n, wantAmount: 3n, escrow: 7n });
  const b = order(2n, { offerToken: Y, wantToken: X, offerAmount: 3n, wantAmount: 7n, escrow: 3n });
  const c = crossPair(a, b)!;
  assert.deepEqual(c.olderFill, { deliver: 3n, draw: 7n });
  assertBatchValid([a, b], [c]);
});

test("every batch the matcher builds passes the pool's settle checks", () => {
  let seed = 11n;
  const rand = (lo: bigint, hi: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return lo + (seed % (hi - lo));
  };
  for (let round = 0; round < 50; round++) {
    const orders: BookOrder[] = [];
    for (let i = 0; i < 8; i++) {
      const buy = rand(0n, 2n) === 0n;
      const base = rand(1n, 10_000n);
      const quote = base * rand(20n, 30n) + rand(0n, 100n);
      orders.push(
        buy
          ? order(BigInt(i + 1), { offerAmount: quote, wantAmount: base, escrow: quote })
          : order(BigInt(i + 1), { offerToken: Y, wantToken: X, offerAmount: base, wantAmount: quote, escrow: base }),
      );
    }
    assertBatchValid(orders, matchBook(orders));
  }
});
