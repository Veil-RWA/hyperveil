// Hyperliquid, for the deployment scripts: the info API (which spot tokens
// exist and how they are scaled), the HyperCore read precompiles reachable
// from HyperEVM, and the one L1 action a deployment needs — `evmUserModify`,
// which routes the deployer's transactions to big blocks.
//
// Why big blocks: HyperEVM makes a small block a second with a 3M gas limit
// and a big block a minute with 30M (Hyperliquid docs, "Dual block
// architecture"). The omnibus is ~18.5 KB of runtime code, so its deployment
// needs more than 3M and would otherwise never be included.

const { ethers } = require('ethers');

// Read precompiles (Hyperliquid docs, "Interacting with HyperCore").
const SPOT_BALANCE = '0x0000000000000000000000000000000000000801';
const CORE_USER_EXISTS = '0x0000000000000000000000000000000000000810';
const coder = ethers.AbiCoder.defaultAbiCoder();

/// POST to the info API.
async function info(baseUrl, body) {
  const res = await fetch(`${baseUrl}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}: ${await res.text()}`);
  return res.json();
}

/// Every spot token HyperCore knows, by ticker.
async function spotTokens(baseUrl) {
  const meta = await info(baseUrl, { type: 'spotMeta' });
  const out = new Map();
  for (const t of meta.tokens) {
    out.set(t.name.toUpperCase(), {
      name: t.name,
      index: t.index,
      szDecimals: t.szDecimals,
      weiDecimals: t.weiDecimals,
    });
  }
  return out;
}

/// The tokens HyperVeil gives a twin, resolved against the live info API:
/// USDC (index 0) first, then whatever was asked for. Nothing is guessed —
/// a ticker the chain does not have is an error, not a default.
async function resolveTokens(baseUrl, tickers) {
  const known = await spotTokens(baseUrl);
  const wanted = ['USDC', ...tickers.map((t) => t.toUpperCase()).filter((t) => t !== 'USDC')];
  return wanted.map((ticker) => {
    const t = known.get(ticker);
    if (!t) {
      throw new Error(
        `Hyperliquid has no spot token "${ticker}" on this network. Known: ` +
        [...known.keys()].slice(0, 40).join(', ') + (known.size > 40 ? ', …' : '')
      );
    }
    if (ticker === 'USDC' && t.index !== 0) throw new Error(`USDC is token ${t.index}, not 0`);
    return t;
  });
}

/// Does `address` have a HyperCore account? CoreWriter actions from an
/// account that does not exist are silently dropped, so the omnibus must be
/// activated before it can trade.
async function coreUserExists(provider, address) {
  const out = await provider.call({ to: CORE_USER_EXISTS, data: coder.encode(['address'], [address]) });
  return coder.decode(['bool'], out)[0];
}

/// `address`'s HyperCore spot balance of `token` (total, hold, entryNtl).
async function spotBalance(provider, address, token) {
  const out = await provider.call({
    to: SPOT_BALANCE,
    data: coder.encode(['address', 'uint64'], [address, token]),
  });
  const [b] = coder.decode(['tuple(uint64 total, uint64 hold, uint64 entryNtl)'], out);
  return { total: b.total, hold: b.hold, entryNtl: b.entryNtl };
}

// ── L1 actions ──────────────────────────────────────────────────────────────
//
// Signing, from Hyperliquid's own Python SDK (`hyperliquid/utils/signing.py`,
// read 2026-09-19): hash = keccak(msgpack(action) ++ nonce as 8 bytes
// big-endian ++ 0x00 for "no vault"); then an EIP-712 signature over
// `Agent{source, connectionId}` in the domain
// {name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x0},
// where source is "a" on mainnet and "b" on testnet.

/// MessagePack, minimal encoding, for the shapes an action here has: maps
/// (written in the order given — field ORDER is part of the hash, exactly as
/// the Python SDK packs the dict), arrays, strings, booleans and integers.
/// Maps are given as arrays of [key, value] pairs so the order is explicit.
function msgpackValue(v) {
  if (typeof v === 'string') {
    const bytes = new TextEncoder().encode(v);
    if (bytes.length < 32) return Uint8Array.from([0xa0 | bytes.length, ...bytes]);
    if (bytes.length < 256) return Uint8Array.from([0xd9, bytes.length, ...bytes]);
    throw new Error('msgpack: string too long');
  }
  if (typeof v === 'boolean') return Uint8Array.from([v ? 0xc3 : 0xc2]);
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = BigInt(v);
    if (n < 0n) throw new Error('msgpack: negative integers are not used here');
    if (n < 128n) return Uint8Array.from([Number(n)]);
    if (n < 256n) return Uint8Array.from([0xcc, Number(n)]);
    if (n < 65536n) return Uint8Array.from([0xcd, Number(n >> 8n), Number(n & 0xffn)]);
    if (n < 4294967296n) {
      return Uint8Array.from([0xce, ...[24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 0xffn))]);
    }
    return Uint8Array.from([
      0xcf, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 0xffn)),
    ]);
  }
  if (Array.isArray(v)) {
    // [[k, v], …] is a map; anything else is an array.
    const isMap = v.length > 0 && v.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string');
    if (isMap) {
      if (v.length > 15) throw new Error('msgpack: only fixmap is implemented');
      const parts = [Uint8Array.from([0x80 | v.length])];
      for (const [k, val] of v) {
        parts.push(msgpackValue(k), msgpackValue(val));
      }
      return ethers.getBytes(ethers.concat(parts));
    }
    if (v.length > 15) throw new Error('msgpack: only fixarray is implemented');
    const parts = [Uint8Array.from([0x90 | v.length])];
    for (const e of v) parts.push(msgpackValue(e));
    return ethers.getBytes(ethers.concat(parts));
  }
  throw new Error(`msgpack: unsupported value ${typeof v}`);
}

const msgpack = (entries) => msgpackValue(entries);

function actionHash(entries, nonce) {
  const packed = msgpack(entries);
  const nonceBytes = ethers.zeroPadValue(ethers.toBeHex(BigInt(nonce)), 8);
  return ethers.keccak256(ethers.concat([packed, nonceBytes, '0x00']));
}

async function signL1Action(wallet, entries, nonce, isMainnet) {
  const domain = {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };
  const value = { source: isMainnet ? 'a' : 'b', connectionId: actionHash(entries, nonce) };
  const signature = await wallet.signTypedData(domain, types, value);
  const { r, s, v } = ethers.Signature.from(signature);
  return { r, s, v };
}

async function postAction(baseUrl, body) {
  const res = await fetch(`${baseUrl}/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hyperliquid exchange ${res.status}: ${text}`);
  const data = JSON.parse(text);
  if (data.status !== 'ok') throw new Error(`Hyperliquid rejected the action: ${text}`);
  return data;
}

/// Routes the SIGNING wallet's HyperEVM transactions to big blocks (30M gas)
/// or back to small ones (3M). The flag lives on the HyperCore user, so the
/// deployer needs a HyperCore account — on testnet, one funded from the faucet.
async function setBigBlocks(baseUrl, wallet, on, isMainnet) {
  const nonce = Date.now();
  const entries = [['type', 'evmUserModify'], ['usingBigBlocks', Boolean(on)]];
  const signature = await signL1Action(wallet, entries, nonce, isMainnet);
  return postAction(baseUrl, {
    action: { type: 'evmUserModify', usingBigBlocks: Boolean(on) },
    nonce,
    signature,
    vaultAddress: null,
  });
}

// ── User-signed actions ─────────────────────────────────────────────────────
//
// A spot send is signed differently from an L1 action: the fields themselves
// are the EIP-712 message (Python SDK `sign_user_signed_action` +
// `SPOT_TRANSFER_SIGN_TYPES`, read 2026-09-20), in the domain
// {name: "HyperliquidSignTransaction", version: "1", chainId: signatureChainId,
// verifyingContract: 0x0}. `nonce` is the same millisecond timestamp as `time`.

const SPOT_SEND_TYPES = {
  'HyperliquidTransaction:SpotSend': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'token', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
  ],
};

/// Sends `amount` (a decimal string) of `token` ("NAME:0x<tokenId>") on
/// HyperCore to `destination`. This is how a contract's HyperCore account is
/// activated: it exists once something is sent to it.
async function spotSend(baseUrl, wallet, destination, token, amount, isMainnet) {
  const time = Date.now();
  const signatureChainId = '0x66eee';
  const message = {
    hyperliquidChain: isMainnet ? 'Mainnet' : 'Testnet',
    destination: destination.toLowerCase(),
    token,
    amount,
    time,
  };
  const domain = {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: Number(BigInt(signatureChainId)),
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  const signature = ethers.Signature.from(
    await wallet.signTypedData(domain, SPOT_SEND_TYPES, message),
  );
  return postAction(baseUrl, {
    action: { type: 'spotSend', signatureChainId, ...message },
    nonce: time,
    signature: { r: signature.r, s: signature.s, v: signature.v },
    vaultAddress: null,
  });
}

const USD_CLASS_TRANSFER_TYPES = {
  'HyperliquidTransaction:UsdClassTransfer': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'toPerp', type: 'bool' },
    { name: 'nonce', type: 'uint64' },
  ],
};

/// Moves `amount` (a decimal string) of USDC between the signer's perps and
/// spot balances on HyperCore (Python SDK `usd_class_transfer`). The testnet
/// faucet credits perps, and a spot send spends spot.
async function usdClassTransfer(baseUrl, wallet, amount, toPerp, isMainnet) {
  const nonce = Date.now();
  const signatureChainId = '0x66eee';
  const message = {
    hyperliquidChain: isMainnet ? 'Mainnet' : 'Testnet',
    amount,
    toPerp: Boolean(toPerp),
    nonce,
  };
  const domain = {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: Number(BigInt(signatureChainId)),
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  const signature = ethers.Signature.from(
    await wallet.signTypedData(domain, USD_CLASS_TRANSFER_TYPES, message),
  );
  return postAction(baseUrl, {
    action: { type: 'usdClassTransfer', signatureChainId, ...message },
    nonce,
    signature: { r: signature.r, s: signature.s, v: signature.v },
    vaultAddress: null,
  });
}

/// One spot order through the exchange, as an L1 action. `px` and `sz` are
/// decimal STRINGS already rounded to Hyperliquid's tick and lot rules; `asset`
/// is 10000 + the spot index. Ioc so it either crosses now or dies.
async function placeSpotOrder(baseUrl, wallet, { asset, isBuy, px, sz }, isMainnet) {
  const nonce = Date.now();
  // Field order is the Python SDK's order wire: a, b, p, s, r, t.
  const order = [
    ['a', asset], ['b', isBuy], ['p', px], ['s', sz], ['r', false],
    ['t', [['limit', [['tif', 'Ioc']]]]],
  ];
  const entries = [['type', 'order'], ['orders', [order]], ['grouping', 'na']];
  const signature = await signL1Action(wallet, entries, nonce, isMainnet);
  const action = {
    type: 'order',
    orders: [{ a: asset, b: isBuy, p: px, s: sz, r: false, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  };
  return postAction(baseUrl, { action, nonce, signature, vaultAddress: null });
}

module.exports = {
  spotSend,
  usdClassTransfer,
  placeSpotOrder,
  msgpackValue,
  info,
  spotTokens,
  resolveTokens,
  coreUserExists,
  spotBalance,
  msgpack,
  actionHash,
  signL1Action,
  setBigBlocks,
  SPOT_BALANCE,
  CORE_USER_EXISTS,
};
