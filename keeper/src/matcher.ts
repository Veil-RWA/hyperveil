// Crossing Veil orders inside Veil before anything goes to Hyperliquid.
//
// The user's rule: check whether Veil has liquidity for the trade; if it does,
// trade directly inside Veil between the users; if not, follow the normal
// procedure (route to Hyperliquid). Crossing inside Veil also keeps two Veil
// users off the same side of HyperCore's self-trade prevention, which would
// cancel one of them: every HyperVeil order rests on the omnibus's one account.
//
// A cross is two opposite orders whose limits overlap. It executes at the
// OLDER order's limit (price-time priority: the resting order sets the price,
// the newer one gets the improvement it asked for or better), and the fills
// satisfy exactly what the pool's `execute_batch_settle` checks: each maker's
// limit price, escrow and delivery cap, and per-token conservation.

export interface BookOrder {
  orderId: bigint;
  offerToken: bigint;
  wantToken: bigint;
  offerAmount: bigint;
  wantAmount: bigint;
  /** `escrow_remaining`. */
  escrow: bigint;
  received: bigint;
  /** Priority: lower first (post time or sequence). */
  postedAt: number;
}

export interface Fill {
  deliver: bigint;
  draw: bigint;
}

export interface Cross {
  older: bigint;
  newer: bigint;
  olderFill: Fill;
  newerFill: Fill;
}

const min = (...v: bigint[]): bigint => v.reduce((a, b) => (b < a ? b : a));

/** How the older order `a` and the newer `b` cross, or null if they do not.
 *  a offers X for Y at oA/wA (X per Y); b offers Y for X at oB/wB. */
export function crossPair(a: BookOrder, b: BookOrder): Cross | null {
  if (a.offerToken !== b.wantToken || a.wantToken !== b.offerToken) return null;
  // Limits overlap iff oA * oB >= wA * wB.
  if (a.offerAmount * b.offerAmount < a.wantAmount * b.wantAmount) return null;
  const aWants = a.wantAmount > a.received ? a.wantAmount - a.received : 0n;
  const bWants = b.wantAmount > b.received ? b.wantAmount - b.received : 0n;
  // y: Y from b to a. x = floor(y * oA / wA): X from a to b, at a's limit.
  // y is bounded so that x fits a's escrow and b's delivery cap.
  const xCap = min(a.escrow, bWants);
  let y = min(b.escrow, aWants, (xCap * a.wantAmount) / a.offerAmount);
  // Flooring x can break b's limit by a unit; a few steps down fix it. When
  // the two limits are exactly equal, only exact multiples work: jump there.
  for (let tries = 0; y > 0n && tries < 64; tries++) {
    const cross = tryCross(a, b, y);
    if (cross) return cross;
    y -= 1n;
  }
  const step = a.wantAmount / gcd(a.offerAmount, a.wantAmount);
  y = (y / step) * step;
  return y > 0n ? tryCross(a, b, y) : null;
}

function tryCross(a: BookOrder, b: BookOrder, y: bigint): Cross | null {
  const x = (y * a.offerAmount) / a.wantAmount;
  // b's limit: y * wB <= x * oB.
  if (x === 0n || y * b.wantAmount > x * b.offerAmount) return null;
  return {
    older: a.orderId,
    newer: b.orderId,
    olderFill: { deliver: y, draw: x },
    newerFill: { deliver: x, draw: y },
  };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Greedy price-time matching over one book. Returns the crosses and leaves
 *  the orders' remaining escrow/received updated as if they had settled. */
export function matchBook(orders: BookOrder[]): Cross[] {
  const book = orders.map((o) => ({ ...o })).sort((p, q) => p.postedAt - q.postedAt);
  const crosses: Cross[] = [];
  for (let i = 0; i < book.length; i++) {
    for (let j = i + 1; j < book.length; j++) {
      const a = book[i];
      const b = book[j];
      if (a.escrow === 0n || b.escrow === 0n) continue;
      const cross = crossPair(a, b);
      if (!cross) continue;
      crosses.push(cross);
      a.escrow -= cross.olderFill.draw;
      a.received += cross.olderFill.deliver;
      b.escrow -= cross.newerFill.draw;
      b.received += cross.newerFill.deliver;
    }
  }
  return crosses;
}
