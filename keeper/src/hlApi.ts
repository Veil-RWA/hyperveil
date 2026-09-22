// Hyperliquid API (docs: "Info endpoint", "Spot", "Exchange endpoint").
//
// Mostly reads: the omnibus is a contract and trades through CoreWriter; the
// keeper reads what happened and reports it. The one thing the keeper signs is
// a deposit's way in: Circle mints the USDC to the keeper, and the keeper
// spot-sends it from its own HyperCore account to the omnibus's.

import { Signature, type Wallet } from "ethers";
import type { HlFill } from "./fills.js";
import type { SpotPair, TokenMeta } from "./hlMath.js";

export const HL_API = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
} as const;

export interface SpotMeta {
  tokens: Array<{ name: string; szDecimals: number; weiDecimals: number; index: number; tokenId?: string }>;
  universe: Array<{ name: string; tokens: [number, number]; index: number }>;
}

export interface OrderStatus {
  /** "unknownOid" when HyperCore has no such order (not placed yet, or
   *  CoreWriter's order was dropped before resting). */
  status: string;
  oid?: bigint;
}

/** The keeper's HyperCore identity: its HyperEVM key, which is the same
 *  address on HyperCore. */
export interface HlSigner {
  wallet: Wallet;
  isMainnet: boolean;
}

/** HyperCore USDC has 8 decimals. */
const USDC_DECIMALS = 8;

/** "12.5" -> 1_250_000_000n (8 dp). */
export function toUsdc8(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > USDC_DECIMALS) throw new Error(`more than 8 decimals: ${amount}`);
  return BigInt(whole || "0") * 10n ** 8n + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

/** 1_250_000_000n -> "12.5": the decimal string HyperCore actions take. */
export function fromUsdc8(amount8: bigint): string {
  const whole = amount8 / 10n ** 8n;
  const frac = (amount8 % 10n ** 8n).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// User-signed actions are EIP-712 over the action's own fields (Python SDK
// `sign_user_signed_action`, `SPOT_TRANSFER_SIGN_TYPES`,
// `USD_CLASS_TRANSFER_SIGN_TYPES`).
const SIGNATURE_CHAIN_ID = "0x66eee";
const USER_SIGNED_DOMAIN = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: Number(BigInt(SIGNATURE_CHAIN_ID)),
  verifyingContract: "0x0000000000000000000000000000000000000000",
};
const SPOT_SEND_TYPES = {
  "HyperliquidTransaction:SpotSend": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
};
const USD_CLASS_TRANSFER_TYPES = {
  "HyperliquidTransaction:UsdClassTransfer": [
    { name: "hyperliquidChain", type: "string" },
    { name: "amount", type: "string" },
    { name: "toPerp", type: "bool" },
    { name: "nonce", type: "uint64" },
  ],
};

export class HyperliquidApi {
  private usdcTokenName?: string;

  constructor(private readonly baseUrl: string, private readonly signer?: HlSigner) {}

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

  /** `user`'s USDC on HyperCore spot, 8 dp. */
  async usdcSpot8(user: string): Promise<bigint> {
    const res = await this.info<{ balances: Array<{ coin: string; total: string }> }>({
      type: "spotClearinghouseState",
      user,
    });
    return toUsdc8(res.balances.find((b) => b.coin === "USDC")?.total ?? "0");
  }

  /** `user`'s USDC withdrawable from HyperCore perps, 8 dp. */
  async usdcPerps8(user: string): Promise<bigint> {
    const res = await this.info<{ withdrawable: string }>({ type: "clearinghouseState", user });
    return toUsdc8(res.withdrawable);
  }

  /** Spot-sends `amount8` USDC from the keeper's HyperCore account. */
  async spotSendUsdc(destination: string, amount8: bigint): Promise<void> {
    const signer = this.need();
    this.usdcTokenName ??= await this.usdcToken();
    const time = Date.now();
    const message = {
      hyperliquidChain: signer.isMainnet ? "Mainnet" : "Testnet",
      destination: destination.toLowerCase(),
      token: this.usdcTokenName,
      amount: fromUsdc8(amount8),
      time,
    };
    const sig = Signature.from(await signer.wallet.signTypedData(USER_SIGNED_DOMAIN, SPOT_SEND_TYPES, message));
    await this.exchange({ type: "spotSend", signatureChainId: SIGNATURE_CHAIN_ID, ...message }, time, sig);
  }

  /** Moves `amount8` USDC between the keeper's perps and spot balances. */
  async usdClassTransfer(amount8: bigint, toPerp: boolean): Promise<void> {
    const signer = this.need();
    const nonce = Date.now();
    const message = {
      hyperliquidChain: signer.isMainnet ? "Mainnet" : "Testnet",
      amount: fromUsdc8(amount8),
      toPerp,
      nonce,
    };
    const sig = Signature.from(
      await signer.wallet.signTypedData(USER_SIGNED_DOMAIN, USD_CLASS_TRANSFER_TYPES, message),
    );
    await this.exchange({ type: "usdClassTransfer", signatureChainId: SIGNATURE_CHAIN_ID, ...message }, nonce, sig);
  }

  /** "USDC:0x<tokenId>", as a spot send names it. */
  private async usdcToken(): Promise<string> {
    const usdc = (await this.spotMeta()).tokens.find((t) => t.index === 0);
    if (!usdc?.tokenId) throw new Error("spotMeta has no USDC token id");
    return `${usdc.name}:${usdc.tokenId}`;
  }

  private need(): HlSigner {
    if (!this.signer) throw new Error("no HyperCore signer: the keeper was built read-only");
    return this.signer;
  }

  private async exchange(action: object, nonce: number, sig: Signature): Promise<void> {
    const res = await fetch(`${this.baseUrl}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Hyperliquid exchange ${res.status}: ${text}`);
    const data = JSON.parse(text) as { status?: string };
    if (data.status !== "ok") throw new Error(`Hyperliquid rejected ${(action as { type: string }).type}: ${text}`);
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
