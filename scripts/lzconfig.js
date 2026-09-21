// LayerZero ULN 302 configuration, encoded for each chain. Shared verbatim
// with bridge/scripts/lzconfig.js: the layouts are LayerZero's, not ours.
//
// The layouts are LayerZero's own:
//   EVM      abi.encode(UlnConfig) and abi.encode(ExecutorConfig), from
//            LayerZero-v2 evm/messagelib/contracts/uln/UlnBase.sol and
//            SendLibBase.sol. A count of 0 means "use the default", 255 means
//            "none" (NIL_DVN_COUNT).
//   Starknet Serde(UlnConfig) and Serde(ExecutorConfig), from
//            @layerzerolabs/protocol-starknet-v2 1.2.33,
//            message_lib/uln_302/structs/*.cairo. Each field has a `has_*`
//            flag; an unflagged field falls back to the default.
// Config type 1 is the executor and 2 the ULN on both chains.
//
// Both chains require DVN lists sorted ascending with no duplicates.

const { ethers } = require('ethers');

const CONFIG_TYPE_EXECUTOR = 1;
const CONFIG_TYPE_ULN = 2;
const NIL_DVN_COUNT = 255;

const EVM_ULN = 'tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)';
const EVM_EXECUTOR = 'tuple(uint32 maxMessageSize, address executor)';
const coder = ethers.AbiCoder.defaultAbiCoder();

/// A pathway policy: which DVNs must sign, how many optional ones, and the
/// source-chain confirmations.
///   { confirmations, required: [addr], optional: [addr], threshold }

function sortAddresses(list) {
  const seen = new Set();
  const out = [];
  for (const a of list.map((x) => BigInt(x)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (seen.has(a)) throw new Error(`duplicate DVN ${a.toString(16)}`);
    seen.add(a);
    out.push(a);
  }
  return out;
}

function assertPolicy(p) {
  if (!(BigInt(p.confirmations) > 0n)) throw new Error('confirmations must be positive');
  if (p.required.length === 0 && (p.threshold ?? 0) === 0) {
    throw new Error('a pathway needs at least one DVN');
  }
  const optional = p.optional ?? [];
  const threshold = p.threshold ?? 0;
  if (optional.length === 0 ? threshold !== 0 : threshold < 1 || threshold > optional.length) {
    throw new Error(`optional threshold ${threshold} does not fit ${optional.length} optional DVNs`);
  }
}

/// EVM: every field explicit, so no LayerZero default change can alter it.
function encodeEvmUln(p) {
  assertPolicy(p);
  const required = sortAddresses(p.required).map((a) => ethers.getAddress(ethers.toBeHex(a, 20)));
  const optional = sortAddresses(p.optional ?? []).map((a) => ethers.getAddress(ethers.toBeHex(a, 20)));
  return coder.encode([EVM_ULN], [{
    confirmations: BigInt(p.confirmations),
    requiredDVNCount: required.length === 0 ? NIL_DVN_COUNT : required.length,
    optionalDVNCount: optional.length === 0 ? NIL_DVN_COUNT : optional.length,
    optionalDVNThreshold: p.threshold ?? 0,
    requiredDVNs: required,
    optionalDVNs: optional,
  }]);
}

function decodeEvmUln(bytes) {
  const [c] = coder.decode([EVM_ULN], bytes);
  return {
    confirmations: BigInt(c.confirmations),
    required: [...c.requiredDVNs].map((a) => a.toLowerCase()),
    optional: [...c.optionalDVNs].map((a) => a.toLowerCase()),
    threshold: Number(c.optionalDVNThreshold),
  };
}

function encodeEvmExecutor({ maxMessageSize, executor }) {
  return coder.encode([EVM_EXECUTOR], [{ maxMessageSize, executor: ethers.getAddress(executor) }]);
}

function decodeEvmExecutor(bytes) {
  const [c] = coder.decode([EVM_EXECUTOR], bytes);
  return { maxMessageSize: Number(c.maxMessageSize), executor: c.executor.toLowerCase() };
}

/// Starknet: Serde(UlnConfig), every `has_*` set.
function encodeStarknetUln(p) {
  assertPolicy(p);
  const required = sortAddresses(p.required);
  const optional = sortAddresses(p.optional ?? []);
  return [
    BigInt(p.confirmations), 1n,
    BigInt(required.length), ...required, 1n,
    BigInt(optional.length), ...optional,
    BigInt(p.threshold ?? 0), 1n,
  ].map((x) => '0x' + x.toString(16));
}

function decodeStarknetUln(felts) {
  const f = felts.map((x) => BigInt(x));
  let i = 0;
  const confirmations = f[i++];
  i++; // has_confirmations
  const requiredLen = Number(f[i++]);
  const required = f.slice(i, i + requiredLen);
  i += requiredLen + 1; // + has_required_dvns
  const optionalLen = Number(f[i++]);
  const optional = f.slice(i, i + optionalLen);
  i += optionalLen;
  const threshold = Number(f[i++]);
  return { confirmations, required, optional, threshold };
}

function encodeStarknetExecutor({ maxMessageSize, executor }) {
  return ['0x' + BigInt(maxMessageSize).toString(16), '0x' + BigInt(executor).toString(16)];
}

function decodeStarknetExecutor(felts) {
  return { maxMessageSize: Number(BigInt(felts[0])), executor: BigInt(felts[1]) };
}

/// Calldata for `Array<SetConfigParam>`: length, then (eid, config_type,
/// config.len, ...config) per entry.
function starknetConfigParams(params) {
  const out = [String(params.length)];
  for (const { eid, configType, config } of params) {
    out.push(String(eid), String(configType), String(config.length), ...config);
  }
  return out;
}

/// Whether an effective config already is the policy (order-insensitive).
function sameUln(effective, policy) {
  const norm = (list) => sortAddresses(list).map(String).join(',');
  return BigInt(effective.confirmations) === BigInt(policy.confirmations)
    && norm(effective.required) === norm(policy.required)
    && norm(effective.optional) === norm(policy.optional ?? [])
    && Number(effective.threshold) === Number(policy.threshold ?? 0);
}

module.exports = {
  CONFIG_TYPE_EXECUTOR,
  CONFIG_TYPE_ULN,
  NIL_DVN_COUNT,
  encodeEvmUln,
  decodeEvmUln,
  encodeEvmExecutor,
  decodeEvmExecutor,
  encodeStarknetUln,
  decodeStarknetUln,
  encodeStarknetExecutor,
  decodeStarknetExecutor,
  starknetConfigParams,
  sameUln,
  sortAddresses,
};
