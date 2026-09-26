// Shared plumbing for the end-to-end driver: configuration, the Starknet
// account, the Veil identity, and the pool reads the app does in the browser.
//
// The app is the only other place this flow exists, and it needs a wallet and
// a browser. This module reproduces exactly what `app/src/veil.ts` does, from
// a private key, so the whole path can be run and debugged from a terminal.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, Contract, RpcProvider } from "starknet";
import {
  VeilERC3643Discovery,
  VeilProver,
  computeNoteId,
  deriveChannelKey,
  derivePublicViewingKey,
  deriveViewingKey,
  makeVeilERC3643ContractReader,
} from "veil-sdk";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");

/** `KEY=value` lines, the way the deploy scripts and the keeper read them. */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function config() {
  const env = {
    ...readEnvFile(join(ROOT, "keeper/.env")),
    ...readEnvFile(join(ROOT, "scripts/.env")),
    ...process.env,
  };
  // The app's generated config, not the raw deployment file: it is what the
  // browser flow reads, and it carries the twins, the CCTP parameters and the
  // fee settings alongside the addresses.
  const d = JSON.parse(readFileSync(join(ROOT, "app/public/deployment.json"), "utf8"));
  const need = (k) => {
    const v = env[k];
    if (!v) throw new Error(`missing ${k} — fill it in keeper/.env or scripts/.env`);
    return v;
  };
  return {
    d,
    rpcUrl: env.SN_RPC_URL || env.SN_PUBLIC_RPC_URL || d.starknet.rpc,
    address: need("SN_ACCOUNT_ADDRESS"),
    privateKey: need("SN_PRIVATE_KEY"),
    prover: {
      endpoint: need("PROVER_ENDPOINT"),
      transport: env.PROVER_TRANSPORT || "job",
      masterAddress: env.VEIL_MASTER_ACCOUNT_ADDRESS || undefined,
    },
    chainId: d.starknet.chainId,
    cctp: d.cctp,
    fees: d.fees,
    twins: d.starknet.twins,
    returnValue: BigInt(env.HV_RETURN_VALUE ?? d.fees.returnValue ?? "0"),
    sn: d.starknet,
  };
}

export const hex = (v) => "0x" + BigInt(v).toString(16);
export const u256 = (v) => [hex(BigInt(v) & ((1n << 128n) - 1n)), hex(BigInt(v) >> 128n)];
export const usdc = (v) => (Number(BigInt(v)) / 1e6).toFixed(6);

const rand = (bytes) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
};
export const randomFelt = () => rand(31) || 1n;
export const randomNoteSalt = () => (rand(15) % ((1n << 120n) - 2n)) + 2n;

export function provider(cfg) {
  return new RpcProvider({ nodeUrl: cfg.rpcUrl });
}

export function account(cfg, p = provider(cfg)) {
  // starknet.js v10 takes one options object, not positional arguments.
  return new Account({ provider: p, address: cfg.address, signer: cfg.privateKey });
}

let poolCache = null;
export async function pool(cfg, p) {
  if (poolCache) return poolCache;
  const cls = await p.getClassAt(cfg.sn.pool);
  const abi = typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi;
  poolCache = new Contract({ abi, address: cfg.sn.pool, providerOrAccount: p });
  return poolCache;
}

export async function reader(cfg, p) {
  return makeVeilERC3643ContractReader(await pool(cfg, p));
}

export async function discovery(cfg, p) {
  return new VeilERC3643Discovery(await reader(cfg, p));
}

/** The viewing key the app keeps in localStorage. Cached here so a rerun
 *  discovers the notes the previous run created. */
export async function identity(cfg, acct) {
  const cache = join(HERE, ".viewing-key.json");
  const owner = BigInt(cfg.address);
  let k;
  if (existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, "utf8"));
    if (saved.owner === hex(owner)) k = BigInt(saved.k);
  }
  if (k === undefined) {
    const vk = await deriveViewingKey(acct, cfg.chainId);
    k = vk.privateKey;
    writeFileSync(cache, JSON.stringify({ owner: hex(owner), k: hex(k) }, null, 1));
  }
  const publicKey = derivePublicViewingKey(k);
  return { owner, k, publicKey, selfChannelKey: deriveChannelKey(owner, k, owner, publicKey) };
}

export function prover(cfg, acct) {
  return new VeilProver({
    veilAddress: cfg.sn.pool,
    // Without this the client treats the pool as the NFT one and skips the
    // SNIP-12 authorization, so every derive arrives one parameter short.
    pool: "erc3643",
    endpoint: cfg.prover.endpoint,
    transport: cfg.prover.transport,
    masterAddress: cfg.prover.masterAddress,
    rpcUrl: cfg.rpcUrl,
    signer: acct,
    chainId: cfg.chainId,
  });
}

/** Prints what the prover is doing; a proof takes minutes, so silence here
 *  is indistinguishable from a hang. */
export const onEvent = (label) => (e) => {
  const what = e?.status ?? e?.type ?? "";
  const detail = e?.error ?? e?.message ?? e?.phase ?? "";
  const line = detail ? `${what} ${detail}` : String(what);
  if (line.trim()) process.stdout.write(`\r      ${label}: ${line.slice(0, 90).padEnd(92)}`);
};

export async function noteValue(cfg, p, noteId) {
  const r = await reader(cfg, p);
  const [enc] = await r.getNotesBatch([noteId]);
  return enc;
}

/** The first free note index in the self-channel, as the app computes it. */
export async function nextNoteIndex(cfg, p, id, token) {
  const r = await reader(cfg, p);
  for (let i = 0; ; i += 32) {
    const ids = Array.from({ length: 32 }, (_, j) => computeNoteId(id.selfChannelKey, token, i + j));
    const encs = await r.getNotesBatch(ids);
    const free = encs.findIndex((e) => e === 0n);
    if (free >= 0) return i + free;
  }
}

export async function planInputs(cfg, p, id, token) {
  const [notes, firstFreeSlot] = await Promise.all([
    (await discovery(cfg, p)).listOwnedNotes(id.owner, id.k),
    nextNoteIndex(cfg, p, id, token),
  ]);
  return {
    owner: id.owner,
    ownerPrivateViewingKey: id.k,
    selfChannelKey: id.selfChannelKey,
    notes,
    firstFreeSlot,
    auditEphemeralSecret: randomFelt(),
    changeNoteSalt: randomNoteSalt(),
    subchannelSalt: randomFelt(),
  };
}

export const step = (n, total, what) => console.log(`\n[${n}/${total}] ${what}`);
export const done = (label, value = "") => console.log(`      ${label.padEnd(24)} ${value}`);
