// An EVM wallet's USDC, over Circle's CCTP V2, between Ethereum and the pool.
//
// In: the wallet burns USDC on Ethereum with the pool's cash vault as both
// mint recipient and destination caller and its open note's id as the hook
// data; Circle attests the burn; the keeper's intake relays the attested
// message to the vault, which mints and fills the note. The wallet never needs
// a Starknet account.
//
// Out: a proven pool invoke pays the cash exit (veil.ts `cashOut`), which burns
// the USDC to the wallet's address; Circle attests; the wallet mints it on
// Ethereum with `receiveMessage`.

import { BrowserProvider, Contract, JsonRpcProvider, toBeHex, zeroPadValue } from "ethers";
import { deployment } from "./config";
import { ensureEthereumChain, type Session } from "./wallet";

/** Circle's CCTP domains. */
export const ETHEREUM_DOMAIN = 0;
export const STARKNET_DOMAIN = 25;

const IRIS = {
  testnet: "https://iris-api-sandbox.circle.com",
  mainnet: "https://iris-api.circle.com",
} as const;

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const TOKEN_MESSENGER = [
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
];
const MESSAGE_TRANSMITTER = ["function receiveMessage(bytes message, bytes attestation) returns (bool)"];

const word = (v: bigint | string): string => zeroPadValue(toBeHex(BigInt(v)), 32);
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

async function evmSigner(session: Session) {
  if (!session.evm) throw new Error("Connect an EVM wallet first.");
  await ensureEthereumChain(session.evm);
  return new BrowserProvider(session.evm as never).getSigner(session.address);
}

/** USDC the wallet holds on Ethereum (6 dp). */
export async function ethereumUsdc(address: string): Promise<bigint> {
  const e = deployment().ethereum;
  return BigInt(await new Contract(e.usdc, ERC20, new JsonRpcProvider(e.rpc)).balanceOf(address));
}

/** Burns `amount` (6 dp) on Ethereum into the pool note `noteId`. Returns the
 *  burn transaction. `maxFee` caps Circle's fast-transfer fee (absolute). */
export async function burnToVeil(
  session: Session,
  amount: bigint,
  noteId: bigint,
  maxFee: bigint,
  say: (m: string) => void,
): Promise<string> {
  const d = deployment();
  const vault = d.starknet.cashVault;
  if (!vault) throw new Error("This deployment has no cash vault for EVM wallets.");
  const e = d.ethereum;
  const signer = await evmSigner(session);
  const usdc = new Contract(e.usdc, ERC20, signer);
  if (BigInt(await usdc.allowance(session.address, e.tokenMessenger)) < amount) {
    say("Approve USDC in your wallet");
    await (await usdc.approve(e.tokenMessenger, amount)).wait();
  }
  say("Confirm the transfer in your wallet");
  const messenger = new Contract(e.tokenMessenger, TOKEN_MESSENGER, signer);
  const tx = await messenger.depositForBurnWithHook(
    amount, STARKNET_DOMAIN, word(vault), e.usdc, word(vault), maxFee, d.cctp.minFinality, word(noteId),
  );
  say("Waiting for Ethereum");
  await tx.wait();
  return tx.hash as string;
}

export interface Attested {
  message: string;
  attestation: string;
}

/** Circle's attested message for the burn in `txHash` on `sourceDomain`.
 *  Polls until Circle has signed it. */
export async function attestation(
  sourceDomain: number,
  txHash: string,
  say: (m: string) => void,
  timeoutMs = 30 * 60_000,
): Promise<Attested> {
  const base = IRIS[deployment().network] ?? IRIS.testnet;
  // Starknet hashes lose their leading zeros; Circle indexes the 64-digit form.
  const bare = txHash.replace(/^0x/i, "");
  const hash = `0x${bare.padStart(64, "0")}`;
  const until = Date.now() + timeoutMs;
  const start = Date.now();
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/v2/messages/${sourceDomain}?transactionHash=${hash}`);
      if (res.ok) {
        const body = (await res.json()) as { messages?: { message?: string; attestation?: string; status?: string }[] };
        const m = body.messages?.[0];
        if (m?.message && m.attestation && m.attestation !== "PENDING" && m.status === "complete") {
          return { message: m.message, attestation: m.attestation };
        }
      }
    } catch {
      /* Circle unreachable for a moment: ask again */
    }
    say(`Waiting for Circle to attest (${Math.round((Date.now() - start) / 1000)}s)`);
    await sleep(4000);
  }
  throw new Error("Circle has not attested the transfer yet. Nothing is lost: it can be finished later.");
}

/** Asks the keeper to hand the attested message to the cash vault. */
export async function relayToVeil(att: Attested): Promise<string> {
  const base = deployment().keeper.intake.replace(/\/$/, "");
  if (!base) throw new Error("This deployment has no keeper intake to relay the transfer.");
  const res = await fetch(`${base}/relay-cash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(att),
  });
  const body = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string };
  if (!res.ok || !body.txHash) throw new Error(body.error ?? `relay failed (HTTP ${res.status})`);
  return body.txHash;
}

/** Mints an attested burn from the pool on Ethereum, from the wallet. */
export async function mintOnEthereum(session: Session, att: Attested): Promise<string> {
  const signer = await evmSigner(session);
  const transmitter = new Contract(deployment().ethereum.messageTransmitter, MESSAGE_TRANSMITTER, signer);
  const tx = await transmitter.receiveMessage(att.message, att.attestation);
  await tx.wait();
  return tx.hash as string;
}

export const etherscanTx = (hash: string): string =>
  `${deployment().network === "mainnet" ? "https://etherscan.io" : "https://sepolia.etherscan.io"}/tx/${hash}`;
