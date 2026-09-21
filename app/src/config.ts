// The deployment this app talks to, read at runtime from /deployment.json so
// an operator can point a built app at new contracts without rebuilding.
//
// An empty address means "not deployed": the app still shows live Hyperliquid
// markets, but every action that needs a contract is disabled.

export interface TwinConfig {
  /** HyperCore spot token index (USDC = 0). */
  hlToken: number;
  /** The twin ERC-20 on Starknet (pool token kind 2). */
  address: string;
  symbol: string;
  /** = the HyperCore token's weiDecimals. */
  decimals: number;
}

export interface Deployment {
  network: "testnet" | "mainnet";
  starknet: {
    rpc: string;
    chainId: string;
    /** First block to scan for HyperVeil events. */
    deployBlock: number;
    pool: string;
    gateway: string;
    entryHelper: string;
    exitVault: string;
    permissionManager: string;
    /** The fee adapter: a STRK note in the pool prepays a LayerZero fee. */
    feeAdapter: string;
    /** The STRK20 -> Veil entry (optional: only "from STRK20" needs it). */
    strk20Entry: string;
    /** Circle USDC on Starknet — a pool token, and what a deposit spends. */
    usdc: string;
    /** STRK: a pool token too, because fees are paid from it. */
    strk: string;
    twins: TwinConfig[];
  };
  hyperliquid: { api: string };
  prover: { endpoint: string; transport?: "sse" | "job"; masterAddress?: string };
  keeper: { intake: string };
  /** A KYC service that decides who may hold HyperVeil assets. NOT used on
   *  this deployment: the allowlist is granted by the keeper to anyone who
   *  asks (see app.ts). */
  kyc?: { url: string };
  fees: {
    /** HYPE (wei) the omnibus gets with a message to pay its reply. Must
     *  equal the keeper's HV_RETURN_VALUE, or it will not route. */
    returnValue: string;
    /** The omnibus's `maxFeeBps`. */
    maxFeeBps: number;
    /** Extra STRK on top of each LayerZero quote, in percent. */
    headroomPct: number;
  };
  cctp: {
    /** CCTP V2's finality threshold: <= 1000 is a fast transfer, >= 2000 the
     *  standard one. From Starknet that is the difference between ~20 seconds
     *  and 2-4 hours, because standard waits for the zk proof to finalize on
     *  Ethereum. Fast costs a fee (Circle quotes 14 bps from Starknet today). */
    minFinality: number;
    /** What we are willing to pay for it, in basis points of the amount. The
     *  burn takes an ABSOLUTE cap, so it is computed per transfer; this is the
     *  rate it is computed from, with headroom over Circle's quote. */
    maxFeeBps: number;
  };
}

let current: Deployment | null = null;

/**
 * `.env` wins over `deployment.json`.
 *
 * The deployment file is generated from what was deployed (addresses, twins,
 * fees) and should not be hand-edited. The endpoints around it — which RPC,
 * which prover, which keeper — are a developer's choice, and live in
 * `VITE_*` variables exactly as they do in veilx and the bridge frontend.
 * Vite only inlines `VITE_*`, and only at startup: restart the dev server
 * after editing `.env`.
 */
function withEnv(d: Deployment): Deployment {
  // Named access, as veilx and the bridge frontend do it: Vite replaces
  // `import.meta.env` with a literal at build time, so the names must be
  // written out rather than looked up from a variable.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const set = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);
  return {
    ...d,
    starknet: { ...d.starknet, rpc: set(env.VITE_STARKNET_RPC_URL) ?? d.starknet.rpc },
    prover: {
      ...d.prover,
      endpoint: set(env.VITE_VEIL_PROVER_ENDPOINT) ?? d.prover.endpoint,
      // Both spellings: veilx uses the first, the bridge frontend the second.
      masterAddress:
        set(env.VITE_VEIL_MASTER_ACCOUNT_ADDRESS) ?? set(env.VITE_VEIL_MASTER_ADDRESS) ?? d.prover.masterAddress,
    },
    keeper: { intake: set(env.VITE_KEEPER_INTAKE) ?? d.keeper.intake },
  };
}

export async function loadDeployment(): Promise<Deployment> {
  const res = await fetch("/deployment.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`deployment.json: HTTP ${res.status}`);
  current = withEnv((await res.json()) as Deployment);
  return current;
}

export function deployment(): Deployment {
  if (!current) throw new Error("deployment not loaded");
  return current;
}

const set = (v: string | undefined): boolean => {
  try {
    return !!v && BigInt(v) !== 0n;
  } catch {
    return false;
  }
};

/** Circle's own testnet faucet: 20 USDC every 2 hours, per address, per
 *  chain, and Starknet Sepolia is one of them. It is where the app sends a
 *  tester who has no USDC — CCTP burns Circle's USDC and nothing else, so it
 *  is also the only kind that reaches Hyperliquid. */
export const CIRCLE_FAUCET = "https://faucet.circle.com/";

/** Whether to offer it: on mainnet there is nothing to claim. */
export const hasTestnetFaucet = (d: Deployment = deployment()): boolean => d.network === "testnet";

/** Every contract a trade, deposit or exit touches is configured. */
export function isDeployed(d: Deployment = deployment()): boolean {
  const s = d.starknet;
  return [s.pool, s.gateway, s.entryHelper, s.exitVault, s.permissionManager, s.feeAdapter, s.usdc, s.strk].every(set) &&
    s.twins.some((t) => t.hlToken === 0);
}

export const usdcTwin = (d: Deployment = deployment()): TwinConfig | undefined =>
  d.starknet.twins.find((t) => t.hlToken === 0);

export const twinOf = (hlToken: number, d: Deployment = deployment()): TwinConfig | undefined =>
  d.starknet.twins.find((t) => t.hlToken === hlToken);

export const twinByAddress = (address: bigint, d: Deployment = deployment()): TwinConfig | undefined =>
  d.starknet.twins.find((t) => set(t.address) && BigInt(t.address) === address);

export const explorer = (d: Deployment = deployment()): string =>
  d.network === "testnet" ? "https://sepolia.voyager.online" : "https://voyager.online";

export const hlExplorer = (d: Deployment = deployment()): string =>
  d.network === "testnet" ? "https://app.hyperliquid-testnet.xyz/explorer" : "https://app.hyperliquid.xyz/explorer";
