// Where a USDC transfer is, between the burn on Starknet and the mint on
// HyperEVM.
//
// Neither chain can answer this: the burn is final the moment it lands, and
// nothing appears on the other side until Circle has attested it and someone
// has carried the attestation over. The only party that knows the middle is
// Circle's attestation service, which answers public GETs (and sends
// `access-control-allow-origin: *`, so a browser may ask it directly).
//
// What it tells us is coarse on purpose — "has Circle signed this yet" — and
// that is the one question a user waiting on a deposit actually has.

import { deployment } from "./config";

export type CctpStage =
  /** Burned on Starknet; Circle has not attested it yet. */
  | "burning"
  /** Circle has signed it; it is waiting to be delivered on HyperEVM. */
  | "attested"
  /** Circle has not heard of this transaction (too new, or not a burn). */
  | "unknown";

const IRIS = {
  testnet: "https://iris-api-sandbox.circle.com",
  mainnet: "https://iris-api.circle.com",
} as const;

/** Circle's domain for Starknet. */
const STARKNET_DOMAIN = 25;

const cache = new Map<string, { at: number; stage: CctpStage }>();
const FRESH_MS = 20_000;

/**
 * Circle's view of one burn, by the transaction that made it.
 *
 * Cached briefly: the portfolio redraws on every account poll, and this is a
 * third party's API, not ours to hammer.
 */
export async function cctpStage(txHash: string): Promise<CctpStage> {
  const hit = cache.get(txHash);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.stage;
  const base = IRIS[deployment().network] ?? IRIS.testnet;
  let stage: CctpStage = "unknown";
  try {
    // Left-padded to 64 hex characters, as Circle's own Starknet quickstart
    // does: a felt loses its leading zeros, and their indexer is keyed on the
    // padded form.
    const bare = txHash.replace(/^0x/i, "");
    const padded = `0x${bare.length < 64 ? bare.padStart(64, "0") : bare}`;
    const res = await fetch(`${base}/v2/messages/${STARKNET_DOMAIN}?transactionHash=${padded}`);
    if (res.ok) {
      const body = (await res.json()) as { messages?: { status?: string; attestation?: string }[] };
      const m = body.messages?.[0];
      const signed = m?.attestation && m.attestation !== "PENDING";
      stage = m ? (signed && m.status === "complete" ? "attested" : "burning") : "unknown";
    } else if (res.status === 404) {
      // Not indexed yet. From Circle's side that is indistinguishable from a
      // transaction that never burned anything, but we only ask about burns.
      stage = "burning";
    }
  } catch {
    stage = "unknown";
  }
  cache.set(txHash, { at: Date.now(), stage });
  return stage;
}

/** What to show while a deposit is in Circle's hands. */
export function cctpLabel(stage: CctpStage): string {
  if (stage === "attested") return "Circle attested · arriving";
  if (stage === "burning") return "Waiting for Circle";
  return "Crossing to Hyperliquid";
}

// ── What Circle charges ─────────────────────────────────────────────────────

/** Circle's domain for HyperEVM. */
const HYPEREVM_DOMAIN = 19;

let quoted: { at: number; bps: number } | null = null;

/**
 * Circle's fee for carrying USDC fast, in basis points of the amount.
 *
 * A fast transfer is paid for out of the transfer itself: what lands on the
 * other side is the amount minus this. Quoted live, because it is Circle's
 * price and not ours — the configured `maxFeeBps` is only the cap we are
 * willing to accept, and showing a cap where a price belongs overstates it.
 */
export async function fastTransferBps(): Promise<number | null> {
  if (quoted && Date.now() - quoted.at < 10 * 60_000) return quoted.bps;
  const base = IRIS[deployment().network] ?? IRIS.testnet;
  try {
    const res = await fetch(`${base}/v2/burn/USDC/fees/${STARKNET_DOMAIN}/${HYPEREVM_DOMAIN}`);
    if (!res.ok) return null;
    const rows = (await res.json()) as { finalityThreshold: number; minimumFee: number }[];
    const want = deployment().cctp.minFinality <= 1000 ? 1000 : 2000;
    const row = rows.find((r) => r.finalityThreshold === want);
    if (!row) return null;
    quoted = { at: Date.now(), bps: row.minimumFee };
    return row.minimumFee;
  } catch {
    return null;
  }
}

/** What Circle would take from `amount6`, at `bps`. Rounded up, as a fee is. */
export const feeOf = (amount6: bigint, bps: number): bigint =>
  bps <= 0 ? 0n : (amount6 * BigInt(Math.round(bps)) + 9999n) / 10000n;
