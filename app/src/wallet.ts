// The Starknet wallet: discovery through get-starknet, then starknet.js's
// `WalletAccountV6`, which also speaks the STRK20 wallet API
// (`wallet_strk20InvokeTransaction`), used when value comes from a STRK20
// balance.
//
// get-starknet v4 hands back the injected `StarknetWindowObject`;
// `StarknetInjectedWallet` wraps it in the wallet-standard shape that
// `WalletAccountV6` takes.

// Must run before get-starknet evaluates (see the file).
import "./noMetaMaskSnap";
import { connect as pickWallet, disconnect as dropWallet } from "@starknet-io/get-starknet";
import { StarknetInjectedWallet } from "@starknet-io/get-starknet-wallet-standard";
import { RpcProvider, WalletAccountV6 } from "starknet";
import { deployment } from "./config";

export interface Session {
  address: string;
  account: WalletAccountV6;
  walletName: string;
}

let provider: RpcProvider | null = null;

export function rpc(): RpcProvider {
  if (!provider) provider = new RpcProvider({ nodeUrl: deployment().starknet.rpc });
  return provider;
}

const AUTOCONNECT = "hyperveil:autoconnect";
const remember = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(AUTOCONNECT, "1");
    else localStorage.removeItem(AUTOCONNECT);
  } catch {
    /* storage unavailable */
  }
};
const mayAutoConnect = (): boolean => {
  try {
    return localStorage.getItem(AUTOCONNECT) === "1";
  } catch {
    return false;
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
  return { address: account.address, account, walletName: wallet.name };
}

export async function connectWallet(): Promise<Session> {
  const injected = await pickWallet({ modalMode: "alwaysAsk", modalTheme: "dark" });
  if (!injected) throw new Error("No wallet selected.");
  const session = await sessionFrom(injected, false);
  remember(true);
  return session;
}

/** Re-attach an already-approved wallet after a reload, without a prompt. */
export async function restoreWallet(): Promise<Session | undefined> {
  if (!mayAutoConnect()) return undefined;
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
  remember(false);
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
  const { transaction_hash } = await session.account.execute({
    contractAddress: token,
    entrypoint: "approve",
    calldata: ["0x" + BigInt(spender).toString(16), "0x" + (amount & U128).toString(16), "0x" + (amount >> 128n).toString(16)],
  });
  await rpc().waitForTransaction(transaction_hash);
  return transaction_hash;
}
