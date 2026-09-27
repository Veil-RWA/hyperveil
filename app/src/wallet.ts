// The wallet: a Starknet account (get-starknet, then starknet.js's
// `WalletAccountV6`, which also speaks the STRK20 wallet API), or an EVM wallet
// (MetaMask and any EIP-1193 wallet). An EVM wallet holds its notes as itself:
// its 20-byte address is the owner in the pool, it signs each proven action
// with `personal_sign` (the pool checks the secp256k1 signature inside the
// proof), and its USDC comes and goes over CCTP from Ethereum — it has no
// Starknet account to send anything from.
//
// get-starknet v4 hands back the injected `StarknetWindowObject`;
// `StarknetInjectedWallet` wraps it in the wallet-standard shape that
// `WalletAccountV6` takes.

// Must run before get-starknet evaluates (see the file).
import "./noMetaMaskSnap";
import { connect as pickWallet, disconnect as dropWallet } from "@starknet-io/get-starknet";
import { StarknetInjectedWallet } from "@starknet-io/get-starknet-wallet-standard";
import { RpcProvider, WalletAccountV6 } from "starknet";
import { eip1193AuthorizationSigner, type AuthorizationSigner } from "veil-sdk";
import { deployment } from "./config";

/** An EIP-1193 provider (window.ethereum). */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface Session {
  kind: "starknet" | "evm";
  /** The holder: the Starknet account, or the EVM address (0x + 40 hex). */
  address: string;
  /** Starknet only: sends the wallet's own transactions. */
  account?: WalletAccountV6;
  /** EVM only: the wallet, for Ethereum transactions (CCTP). */
  evm?: Eip1193;
  /** Authorizes each proven action. */
  signer: AuthorizationSigner;
  walletName: string;
}

let provider: RpcProvider | null = null;

export function rpc(): RpcProvider {
  if (!provider) provider = new RpcProvider({ nodeUrl: deployment().starknet.rpc });
  return provider;
}

const AUTOCONNECT = "hyperveil:autoconnect";
/** Which wallet to re-attach on load: "1" (Starknet, as before) or "evm". */
const remember = (kind: "starknet" | "evm" | null): void => {
  try {
    if (kind) localStorage.setItem(AUTOCONNECT, kind === "evm" ? "evm" : "1");
    else localStorage.removeItem(AUTOCONNECT);
  } catch {
    /* storage unavailable */
  }
};
const autoConnectKind = (): "starknet" | "evm" | null => {
  try {
    const v = localStorage.getItem(AUTOCONNECT);
    return v === "evm" ? "evm" : v === "1" ? "starknet" : null;
  } catch {
    return null;
  }
};

export class WrongChainError extends Error {
  constructor(got: string) {
    super(`Your wallet is on ${got}; HyperVeil here runs on ${deployment().network === "testnet" ? "Starknet Sepolia" : "Starknet mainnet"}. Switch network and reconnect.`);
    this.name = "WrongChainError";
  }
}

const sameFelt = (a: string, b: string): boolean => {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
};

async function sessionFrom(injected: unknown, silent: boolean): Promise<Session> {
  const wallet = new StarknetInjectedWallet(injected as never);
  const account = await WalletAccountV6.connect(rpc(), wallet as never, undefined, undefined, silent);
  if (!account.address) throw new Error("The wallet did not return an account.");
  // A wallet on another chain would sign authorizations for a chain where
  // none of these contracts exist, and derive a viewing key for it.
  const w = injected as { request?: (a: { type: string }) => Promise<string>; chainId?: string };
  let chain: string | undefined;
  try {
    chain = w.request ? await w.request({ type: "wallet_requestChainId" }) : w.chainId;
  } catch {
    chain = w.chainId;
  }
  if (chain && !sameFelt(chain, deployment().starknet.chainId)) throw new WrongChainError(chain);
  return { kind: "starknet", address: account.address, account, signer: account as never, walletName: wallet.name };
}

export async function connectWallet(): Promise<Session> {
  const injected = await pickWallet({ modalMode: "alwaysAsk", modalTheme: "dark" });
  if (!injected) throw new Error("No wallet selected.");
  const session = await sessionFrom(injected, false);
  remember("starknet");
  return session;
}

// ── EVM wallet ──────────────────────────────────────────────────────────────

function ethereum(): Eip1193 {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error("No EVM wallet found. Install MetaMask (or another EVM wallet) and reload.");
  return eth;
}

/** Puts the wallet on the Ethereum chain HyperVeil's USDC comes from. */
export async function ensureEthereumChain(eth: Eip1193): Promise<void> {
  const want = "0x" + deployment().ethereum.chainId.toString(16);
  const have = String(await eth.request({ method: "eth_chainId" }));
  if (BigInt(have) === BigInt(want)) return;
  await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
}

function evmSession(eth: Eip1193, address: string): Session {
  const a = "0x" + BigInt(address).toString(16).padStart(40, "0");
  return { kind: "evm", address: a, evm: eth, signer: eip1193AuthorizationSigner(eth, a), walletName: "EVM wallet" };
}

export async function connectEvmWallet(): Promise<Session> {
  const eth = ethereum();
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("The EVM wallet did not return an account.");
  await ensureEthereumChain(eth);
  remember("evm");
  return evmSession(eth, accounts[0]);
}

/** Re-attach an already-approved wallet after a reload, without a prompt. */
export async function restoreWallet(): Promise<Session | undefined> {
  const kind = autoConnectKind();
  if (!kind) return undefined;
  if (kind === "evm") {
    try {
      const eth = ethereum();
      const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
      return accounts?.length ? evmSession(eth, accounts[0]) : undefined;
    } catch {
      return undefined;
    }
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const injected = await pickWallet({ modalMode: "neverAsk" });
      if (injected) return await sessionFrom(injected, true);
    } catch {
      return undefined;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

export async function disconnectWallet(): Promise<void> {
  const wasEvm = autoConnectKind() === "evm";
  remember(null);
  if (wasEvm) return;
  try {
    await dropWallet({ clearLastWallet: true });
  } catch {
    /* already gone */
  }
}

/** One public wallet transaction: approve `spender` for `amount` of `token`.
 *  The only place HyperVeil needs the wallet to move a token itself — a plain
 *  deposit into the Veil pool. */
export async function approve(session: Session, token: string, spender: string, amount: bigint): Promise<string> {
  const U128 = (1n << 128n) - 1n;
  if (!session.account) throw new Error("An EVM wallet has no Starknet account: bring USDC from Ethereum instead.");
  const { transaction_hash } = await session.account.execute({
    contractAddress: token,
    entrypoint: "approve",
    calldata: ["0x" + BigInt(spender).toString(16), "0x" + (amount & U128).toString(16), "0x" + (amount >> 128n).toString(16)],
  });
  await rpc().waitForTransaction(transaction_hash);
  return transaction_hash;
}
