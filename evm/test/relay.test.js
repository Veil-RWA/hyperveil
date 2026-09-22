// The testnet relay endpoint, driving the REAL omnibus.
//
// LayerZero has not enabled the HyperEVM testnet <-> Starknet Sepolia pathway,
// so on testnet the omnibus is deployed against this endpoint instead. The
// omnibus itself is unchanged, which is what these tests check: it accepts an
// instruction delivered this way, answers through it without needing a budget,
// and the endpoint hands delivery to the relayer alone.

const { Chain_, test, eq, ok, reverts, succeeds, run, ethers } = require('./harness');

const OWNER = 1;
const KEEPER = 2;
const STRANGER = 3;
const addr = (n) => '0x' + BigInt(n).toString(16).padStart(40, '0');
const B32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

const SN_EID = 40500;
const GATEWAY = B32(0x5a5a5a);
const ENTRY_HELPER = B32(0xe1e1e1);
const USDC = 0n;
const DEPOSIT_ID = B32(0xd1);
const DEPOSIT6 = 1_000_000_000n;

const packed = (types, values) => ethers.solidityPacked(types, values);
const depositMsg = (id, amount6) => packed(['uint8', 'bytes32', 'uint128'], [1, id, amount6]);

async function setup() {
  const chain = await Chain_.create();
  chain.setTime(1_700_000_000);
  await chain.deployAt('MockCoreWriter', '0x3333333333333333333333333333333333333333');
  const spotBalance = await chain.deployAt('MockSpotBalance', '0x0000000000000000000000000000000000000801');
  await chain.deployAt('MockSpotInfo', '0x000000000000000000000000000000000000080b');
  await chain.deployAt('MockTokenInfo', '0x000000000000000000000000000000000000080C');
  const usdc = await chain.deploy('MockUSDC');
  const transmitter = await chain.deploy('MockMessageTransmitter', [usdc.hex]);
  const messenger = await chain.deploy('MockTokenMessenger', [usdc.hex]);
  // The relay endpoint stands where LayerZero's would.
  const endpoint = await chain.deploy('HyperVeilRelayEndpoint', [addr(OWNER), addr(KEEPER)]);
  const omnibus = await chain.deploy('HyperVeilOmnibus', [
    endpoint.hex, addr(OWNER), SN_EID, usdc.hex, messenger.hex, transmitter.hex,
  ]);
  succeeds(await omnibus.call('setPeer', [SN_EID, GATEWAY], OWNER));
  succeeds(await omnibus.call('setKeeper', [addr(KEEPER)], OWNER));
  succeeds(await omnibus.call('setEntryHelper', [ENTRY_HELPER], OWNER));
  return { chain, endpoint, omnibus, usdc, spotBalance };
}

const deliver = (env, message, from = KEEPER) =>
  env.endpoint.call('deliver', [env.omnibus.hex, SN_EID, GATEWAY, message], from);

test('the relayer delivers an instruction and the omnibus takes it as the gateway\'s', async () => {
  const env = await setup();
  succeeds(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6)));
  const d = (await env.omnibus.call('deposits', [DEPOSIT_ID])).decoded;
  eq(d[0], DEPOSIT6, 'the instruction was recorded');
  ok(d[3] === true, 'lzSeen');
});

test('only the relayer delivers', async () => {
  const env = await setup();
  reverts(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6), STRANGER), 'OnlyRelayer');
});

test('a reply needs no budget: the relay charges nothing', async () => {
  const env = await setup();
  // Both halves of a deposit, then the credit the omnibus answers with.
  succeeds(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6)));
  const m = ethers.solidityPacked(
    ['uint32', 'uint32', 'uint32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint32', 'uint32',
      'uint32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [1, 25, 19, B32(0x99), B32(0x07d4), B32(0x28b5), B32(BigInt(env.omnibus.hex)), 2000, 2000,
      1, B32(0x0330), B32(KEEPER), DEPOSIT6, ENTRY_HELPER, 0, 0, 0, DEPOSIT_ID]
  );
  succeeds(await env.omnibus.call('receiveDeposit', [m, ethers.toUtf8Bytes('ATTESTED')], STRANGER));
  // Circle minted to the keeper, which spot-sends it to the omnibus.
  await env.spotBalance.call('credit', [env.omnibus.hex, USDC, DEPOSIT6 * 100n]);
  // No budget was ever funded (no value came with the instruction), and the
  // credit still goes out: on this endpoint a message is free.
  eq((await env.omnibus.call('budget', [DEPOSIT_ID])).decoded[0], 0n, 'no budget');
  succeeds(await env.omnibus.call('creditDeposit', [DEPOSIT_ID], STRANGER), 'credit sent');
  eq(await (async () => (await env.omnibus.call('liability', [USDC])).decoded[0])(), DEPOSIT6 * 100n, 'twin credited');
  eq((await env.endpoint.call('sentCount')).decoded[0], 2n, 'one delivery + one reply');
});

test('the owner can hand the relay to another keeper', async () => {
  const env = await setup();
  reverts(await env.endpoint.call('setRelayer', [addr(STRANGER)], STRANGER), 'OnlyOwner');
  succeeds(await env.endpoint.call('setRelayer', [addr(STRANGER)], OWNER));
  succeeds(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6), STRANGER));
});

run();
