// HyperVeilOmnibus on a simulated HyperEVM.
//
// HyperCore is stood in for at its real addresses: CoreWriter (0x3333...) and
// the read precompiles (spotBalance 0x801, spotInfo 0x80b, tokenInfo 0x80C).
// Circle's USDC, CCTP and CoreDepositWallet and the LayerZero endpoint are
// mocks reproducing the behaviour the omnibus relies on (test/Mocks.sol).
//
// What HyperCore would do after an action (fill an order, pay out to the EVM)
// the tests do by hand, then check what the omnibus accepts as a result.

const { Chain_, test, eq, ok, reverts, succeeds, run, ethers } = require('./harness');

const OWNER = 1;
const KEEPER = 2;
const STRANGER = 3;
const SYSTEM = 0x2000000000000000000000000000000000000000n;
const addr = (n) => '0x' + BigInt(n).toString(16).padStart(40, '0');
const B32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const word = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

const SN_EID = 30500;
const GATEWAY = B32(0x5a5a5a);
const ENTRY_HELPER = B32(0xe1e1e1);
const EXIT_VAULT = B32(0x7a7a7a);
const LZ_FEE = 1000n;
const BUDGET = 10000n;

const USDC = 0n;
const HYPE = 150n;
const SPOT = 107; // HYPE/USDC spot index -> asset 10107
const ASSET = 10000 + SPOT;

const packed = (types, values) => ethers.solidityPacked(types, values);
const abi = ethers.AbiCoder.defaultAbiCoder();

function depositMsg(id, amount6) {
  return packed(['uint8', 'bytes32', 'uint128'], [1, id, amount6]);
}
function placeMsg(p) {
  return packed(
    ['uint8', 'bytes32', 'uint128', 'uint32', 'bool', 'uint64', 'uint64', 'uint8', 'uint64', 'uint64', 'uint128', 'uint128', 'uint128'],
    [2, p.routeId, p.cloid, p.asset, p.isBuy, p.px, p.sz, p.tif, p.offerToken, p.wantToken, p.offerAmount, p.wantAmount, p.escrow]
  );
}
function cancelMsg(id) {
  return packed(['uint8', 'bytes32'], [3, id]);
}
function withdrawMsg(id, amount8) {
  return packed(['uint8', 'bytes32', 'uint128'], [4, id, amount8]);
}
function creditMsg(id, amount8) {
  return packed(['uint8', 'bytes32', 'uint128'], [5, id, amount8]);
}
function fillMsg(items) {
  let out = packed(['uint8', 'uint16'], [6, items.length]);
  for (const it of items) {
    out += packed(['bytes32', 'uint64', 'uint128', 'uint128', 'bool'], [it.routeId, it.seq, it.cumDraw, it.cumDeliver, it.closed]).slice(2);
  }
  return out;
}

// Circle's CCTP V2 burn message from Starknet (domain 25) to this omnibus.
function cctpMsg({ omnibus, sender = ENTRY_HELPER, domain = 25, caller, recipient, amount6, fee = 0n, hook }) {
  return packed(
    ['uint32', 'uint32', 'uint32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint32', 'uint32',
      'uint32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [1, domain, 19, B32(0x99), B32(0x07d4), B32(0x28b5), caller ?? word(omnibus), 2000, 2000,
      1, B32(0x0330), recipient ?? word(omnibus), amount6, sender, 0, fee, 0, hook]
  );
}

async function setup() {
  const chain = await Chain_.create();
  chain.setTime(1_700_000_000);
  const coreWriter = await chain.deployAt('MockCoreWriter', '0x3333333333333333333333333333333333333333');
  const spotBalance = await chain.deployAt('MockSpotBalance', '0x0000000000000000000000000000000000000801');
  const spotInfo = await chain.deployAt('MockSpotInfo', '0x000000000000000000000000000000000000080b');
  const tokenInfo = await chain.deployAt('MockTokenInfo', '0x000000000000000000000000000000000000080C');
  const usdc = await chain.deploy('MockUSDC');
  const transmitter = await chain.deploy('MockMessageTransmitter', [usdc.hex]);
  const messenger = await chain.deploy('MockTokenMessenger', [usdc.hex]);
  const wallet = await chain.deploy('MockCoreDepositWallet', [usdc.hex, spotBalance.hex]);
  const endpoint = await chain.deploy('MockEndpoint');
  const omnibus = await chain.deploy('HyperVeilOmnibus', [
    endpoint.hex, addr(OWNER), SN_EID, usdc.hex, messenger.hex, transmitter.hex, wallet.hex,
  ]);
  succeeds(await omnibus.call('setPeer', [SN_EID, GATEWAY], OWNER));
  succeeds(await omnibus.call('setKeeper', [addr(KEEPER)], OWNER));
  succeeds(await omnibus.call('setEntryHelper', [ENTRY_HELPER], OWNER));
  succeeds(await omnibus.call('setExitVault', [EXIT_VAULT], OWNER));
  await endpoint.call('setFee', [LZ_FEE]);
  await spotInfo.call('setSpot', [SPOT, HYPE, USDC]);
  await tokenInfo.call('setToken', [Number(HYPE), 2, 8]);
  await tokenInfo.call('setToken', [Number(USDC), 8, 8]);
  return { chain, coreWriter, spotBalance, spotInfo, tokenInfo, usdc, transmitter, messenger, wallet, endpoint, omnibus };
}

const deliver = (env, message, value = BUDGET) =>
  env.endpoint.call('deliver', [env.omnibus.hex, SN_EID, GATEWAY, message], STRANGER, value);

async function lastMessage(env) {
  return (await env.endpoint.call('lastMessage')).decoded[0];
}
async function liability(env, token) {
  return (await env.omnibus.call('liability', [token])).decoded[0];
}
async function lastAction(env) {
  return (await env.coreWriter.call('lastAction')).decoded[0];
}
async function actionCount(env) {
  return (await env.coreWriter.call('actionCount')).decoded[0];
}

// A full deposit: the LayerZero instruction, the CCTP USDC, then the credit.
const DEPOSIT_ID = B32(0xd1);
const DEPOSIT6 = 1_000_000_000n; // 1_000 USDC
async function deposited(env, id = DEPOSIT_ID, amount6 = DEPOSIT6) {
  succeeds(await deliver(env, depositMsg(id, amount6)), 'deposit instruction');
  const m = cctpMsg({ omnibus: env.omnibus.hex, amount6, hook: id });
  succeeds(await env.omnibus.call('receiveDeposit', [m, ethers.toUtf8Bytes('ATTESTED')], STRANGER), 'cctp');
  succeeds(await env.omnibus.call('creditDeposit', [id], STRANGER), 'credit');
}

// ── Deposits ────────────────────────────────────────────────────────────────

test('a deposit is credited once both its instruction and its USDC arrived on HyperCore', async () => {
  const env = await setup();
  succeeds(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6)));
  const m = cctpMsg({ omnibus: env.omnibus.hex, amount6: DEPOSIT6, fee: 100_000n, hook: DEPOSIT_ID });
  succeeds(await env.omnibus.call('receiveDeposit', [m, ethers.toUtf8Bytes('ATTESTED')], STRANGER));
  // Moved on to HyperCore spot at once: nothing is left on the EVM.
  eq((await env.usdc.call('balanceOf', [env.omnibus.hex])).decoded[0], 0n);
  const arrived = DEPOSIT6 - 100_000n;
  eq((await env.spotBalance.call('total', [env.omnibus.hex, USDC])).decoded[0], arrived * 100n);

  succeeds(await env.omnibus.call('creditDeposit', [DEPOSIT_ID], STRANGER));
  eq(await liability(env, USDC), arrived * 100n);
  eq(await lastMessage(env), creditMsg(DEPOSIT_ID, arrived * 100n));
  eq((await env.endpoint.call('lastValue')).decoded[0], LZ_FEE);
});

test('a credit waits for the CCTP half', async () => {
  const env = await setup();
  succeeds(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6)));
  reverts(await env.omnibus.call('creditDeposit', [DEPOSIT_ID], STRANGER), 'DepositNotReady');
});

test('a credit waits for the LayerZero half', async () => {
  const env = await setup();
  const m = cctpMsg({ omnibus: env.omnibus.hex, amount6: DEPOSIT6, hook: DEPOSIT_ID });
  succeeds(await env.omnibus.call('receiveDeposit', [m, ethers.toUtf8Bytes('ATTESTED')], STRANGER));
  reverts(await env.omnibus.call('creditDeposit', [DEPOSIT_ID], STRANGER), 'DepositNotReady');
});

test('a deposit is credited once', async () => {
  const env = await setup();
  await deposited(env);
  reverts(await env.omnibus.call('creditDeposit', [DEPOSIT_ID], STRANGER), 'DepositNotReady');
});

test('a credit HyperCore does not back is refused', async () => {
  const env = await setup();
  succeeds(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6)));
  const m = cctpMsg({ omnibus: env.omnibus.hex, amount6: DEPOSIT6, hook: DEPOSIT_ID });
  succeeds(await env.omnibus.call('receiveDeposit', [m, ethers.toUtf8Bytes('ATTESTED')], STRANGER));
  // HyperCore never credited the account (say the deposit was rejected there).
  await env.spotBalance.call('set', [env.omnibus.hex, USDC, 0]);
  reverts(await env.omnibus.call('creditDeposit', [DEPOSIT_ID], STRANGER), 'Insolvent');
});

test('only the entry helper deposits, from Starknet, to this omnibus, for itself to relay', async () => {
  const env = await setup();
  const base = { omnibus: env.omnibus.hex, amount6: DEPOSIT6, hook: DEPOSIT_ID };
  const call = (m) => env.omnibus.call('receiveDeposit', [m, ethers.toUtf8Bytes('ATTESTED')], STRANGER);
  reverts(await call(cctpMsg({ ...base, sender: B32(0xbad) })), 'BadCctpMessage');
  reverts(await call(cctpMsg({ ...base, domain: 0 })), 'BadCctpMessage');
  reverts(await call(cctpMsg({ ...base, recipient: B32(0xbad) })), 'BadCctpMessage');
  reverts(await call(cctpMsg({ ...base, caller: B32(0) })), 'BadCctpMessage');
});

test('a deposit instruction is taken once', async () => {
  const env = await setup();
  succeeds(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6)));
  reverts(await deliver(env, depositMsg(DEPOSIT_ID, DEPOSIT6)), ethers.id('DuplicateInstruction(bytes32)').slice(0, 10));
});

// ── Orders ──────────────────────────────────────────────────────────────────

// A Veil buy: 1_000 USDC for 40 HYPE (limit 25 USDC/HYPE), 8 dp both sides.
// Placed on HyperCore at 24.9 for 40 (1e8 fixed point).
const ROUTE = B32(0xabc);
const ORDER = {
  routeId: ROUTE,
  cloid: 0xabcn,
  asset: ASSET,
  isBuy: true,
  px: 2_490_000_000n,
  sz: 4_000_000_000n,
  tif: 2,
  offerToken: USDC,
  wantToken: HYPE,
  offerAmount: 100_000_000_000n,
  wantAmount: 4_000_000_000n,
  escrow: 100_000_000_000n,
};

async function placed(env, order = ORDER) {
  await deposited(env);
  succeeds(await deliver(env, placeMsg(order)), 'place');
}

test('a place within the Veil order becomes a HyperCore limit order', async () => {
  const env = await setup();
  await placed(env);
  const expected = '0x01000001' + abi.encode(
    ['uint32', 'bool', 'uint64', 'uint64', 'bool', 'uint8', 'uint128'],
    [ASSET, true, ORDER.px, ORDER.sz, false, 2, ORDER.cloid]
  ).slice(2);
  eq(await lastAction(env), expected);
  // The escrow's twins were burned on Starknet: no longer owed as twins.
  eq(await liability(env, USDC), 0n);
  eq((await env.omnibus.call('routes', [ROUTE])).decoded.status, 1n);
});

async function expectRejected(env, order, reason) {
  await deposited(env);
  const before = await actionCount(env);
  succeeds(await deliver(env, placeMsg(order)), 'rejection delivers');
  eq(await actionCount(env), before, 'an order reached HyperCore');
  eq(await liability(env, USDC), 100_000_000_000n, 'ledger touched');
  eq((await env.omnibus.call('routes', [order.routeId])).decoded.status, 3n);
  // The whole escrow is released at once.
  eq(await lastMessage(env), fillMsg([{ routeId: order.routeId, seq: 1, cumDraw: 0, cumDeliver: 0, closed: true }]));
  eq((await env.omnibus.call('checkPlace', [order])).decoded[0], ethers.encodeBytes32String(reason));
}

test('a buy priced above the maker limit (after the worst fee) is rejected', async () => {
  const env = await setup();
  await expectRejected(env, { ...ORDER, px: 2_500_000_000n }, 'OVER_LIMIT');
});

test('a buy of more than the maker wants is rejected', async () => {
  const env = await setup();
  await expectRejected(env, { ...ORDER, sz: 4_100_000_000n, px: 2_400_000_000n }, 'OVER_WANT');
});

test('a buy that could spend more than the escrow is rejected', async () => {
  const env = await setup();
  await expectRejected(env, { ...ORDER, escrow: 50_000_000_000n }, 'OVER_ESCROW');
});

test('an order on the wrong pair is rejected', async () => {
  const env = await setup();
  await expectRejected(env, { ...ORDER, isBuy: false }, 'PAIR');
});

test('an unknown asset is rejected without burning the call', async () => {
  const env = await setup();
  await expectRejected(env, { ...ORDER, asset: 10999 }, 'UNKNOWN_ASSET');
});

test('a sell must clear the maker limit after the worst fee', async () => {
  const env = await setup();
  // Sell 40 HYPE for at least 1_000 USDC: limit 25. At 25.0 the fee breaks it.
  const sell = {
    ...ORDER,
    isBuy: false,
    offerToken: HYPE,
    wantToken: USDC,
    offerAmount: 4_000_000_000n,
    wantAmount: 100_000_000_000n,
    escrow: 4_000_000_000n,
    px: 2_500_000_000n,
  };
  eq((await env.omnibus.call('checkPlace', [sell])).decoded[0], ethers.encodeBytes32String('UNDER_LIMIT'));
  eq((await env.omnibus.call('checkPlace', [{ ...sell, px: 2_503_000_000n }])).decoded[0], ethers.ZeroHash);
});

test('a rejection with no budget to answer is left for LayerZero to retry', async () => {
  const env = await setup();
  await deposited(env);
  reverts(await deliver(env, placeMsg({ ...ORDER, px: 2_500_000_000n }), 0n), ethers.id('BudgetTooLow(uint256,uint256)').slice(0, 10));
});

test('a cancel reaches HyperCore by cloid', async () => {
  const env = await setup();
  await placed(env);
  succeeds(await deliver(env, cancelMsg(ROUTE)));
  eq(await lastAction(env), '0x0100000b' + abi.encode(['uint32', 'uint128'], [ASSET, ORDER.cloid]).slice(2));
});

test('a cancel that overtakes its place stops the order before it exists', async () => {
  const env = await setup();
  await deposited(env);
  succeeds(await deliver(env, cancelMsg(ROUTE)));
  const before = await actionCount(env);
  succeeds(await deliver(env, placeMsg(ORDER)));
  eq(await actionCount(env), before);
  eq(await lastMessage(env), fillMsg([{ routeId: ROUTE, seq: 1, cumDraw: 0, cumDeliver: 0, closed: true }]));
});

// ── Reports ─────────────────────────────────────────────────────────────────

// HyperCore filled 10 HYPE for 249 USDC (the fee came out of the HYPE).
async function hyperCoreFilled(env, drawUsdc, deliverHype) {
  await env.spotBalance.call('debit', [env.omnibus.hex, USDC, drawUsdc]);
  await env.spotBalance.call('credit', [env.omnibus.hex, HYPE, deliverHype]);
}

const report = (env, items, from = KEEPER) => env.omnibus.call('report', [items], from);

test('a fill backed by HyperCore is reported to Starknet', async () => {
  const env = await setup();
  await placed(env);
  await hyperCoreFilled(env, 24_900_000_000n, 999_300_000n);
  succeeds(await report(env, [{ routeId: ROUTE, cumDraw: 24_900_000_000n, cumDeliver: 999_300_000n, closed: false }]));
  eq(await liability(env, HYPE), 999_300_000n);
  eq(await lastMessage(env), fillMsg([{ routeId: ROUTE, seq: 1, cumDraw: 24_900_000_000n, cumDeliver: 999_300_000n, closed: false }]));
});

test('a fill HyperCore does not back is refused', async () => {
  const env = await setup();
  await placed(env);
  await hyperCoreFilled(env, 24_900_000_000n, 500_000_000n);
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 12_000_000_000n, cumDeliver: 999_300_000n, closed: false }]), 'Insolvent');
});

test('a report cannot beat the maker limit', async () => {
  const env = await setup();
  await placed(env);
  await hyperCoreFilled(env, 25_100_000_000n, 1_000_000_000n);
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 25_100_000_000n, cumDeliver: 1_000_000_000n, closed: false }]), 'LimitPrice');
});

test('a report cannot draw beyond the escrow, go backwards, or draw for nothing', async () => {
  const env = await setup();
  await placed(env);
  await hyperCoreFilled(env, 24_900_000_000n, 1_000_000_000n);
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 100_000_000_001n, cumDeliver: 4_000_000_000n, closed: false }]), 'OverEscrow');
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 100n, cumDeliver: 0n, closed: false }]), 'DrawWithoutDelivery');
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 0n, cumDeliver: 0n, closed: false }]), 'EmptyReport');
  succeeds(await report(env, [{ routeId: ROUTE, cumDraw: 24_900_000_000n, cumDeliver: 1_000_000_000n, closed: false }]));
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 24_900_000_000n, cumDeliver: 900_000_000n, closed: false }]), 'Regressed');
});

test('only the keeper reports', async () => {
  const env = await setup();
  await placed(env);
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 0n, cumDeliver: 0n, closed: true }], STRANGER), 'OnlyKeeper');
});

test('closing returns the unspent escrow to the ledger, if HyperCore still holds it', async () => {
  const env = await setup();
  await placed(env);
  await hyperCoreFilled(env, 24_900_000_000n, 1_000_000_000n);
  succeeds(await report(env, [{ routeId: ROUTE, cumDraw: 24_900_000_000n, cumDeliver: 1_000_000_000n, closed: true }]));
  eq(await liability(env, USDC), 100_000_000_000n - 24_900_000_000n);
  eq((await env.omnibus.call('routes', [ROUTE])).decoded.status, 2n);
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 24_900_000_000n, cumDeliver: 1_000_000_000n, closed: true }]), 'RouteNotOpen');
});

test('under-reporting what was spent cannot close', async () => {
  const env = await setup();
  await placed(env);
  // HyperCore spent 498 USDC; the keeper claims 249.
  await hyperCoreFilled(env, 49_800_000_000n, 2_000_000_000n);
  reverts(await report(env, [{ routeId: ROUTE, cumDraw: 24_900_000_000n, cumDeliver: 1_000_000_000n, closed: true }]), 'Insolvent');
});

test('several routes are reported in one message', async () => {
  const env = await setup();
  await deposited(env);
  const a = { ...ORDER, routeId: B32(0xa1), cloid: 0xa1n, escrow: 50_000_000_000n, offerAmount: 50_000_000_000n, wantAmount: 2_000_000_000n, sz: 2_000_000_000n };
  const b = { ...a, routeId: B32(0xb2), cloid: 0xb2n };
  succeeds(await deliver(env, placeMsg(a)));
  succeeds(await deliver(env, placeMsg(b)));
  await hyperCoreFilled(env, 49_800_000_000n, 2_000_000_000n);
  succeeds(await report(env, [
    { routeId: a.routeId, cumDraw: 24_900_000_000n, cumDeliver: 1_000_000_000n, closed: false },
    { routeId: b.routeId, cumDraw: 24_900_000_000n, cumDeliver: 1_000_000_000n, closed: false },
  ]));
  eq(await lastMessage(env), fillMsg([
    { routeId: a.routeId, seq: 1, cumDraw: 24_900_000_000n, cumDeliver: 1_000_000_000n, closed: false },
    { routeId: b.routeId, seq: 1, cumDraw: 24_900_000_000n, cumDeliver: 1_000_000_000n, closed: false },
  ]));
});

// ── Exits ───────────────────────────────────────────────────────────────────

const EXIT_ID = B32(0xe417);
const EXIT8 = 10_000_000_000n; // 100 USDC

test('an exit leaves HyperCore for the EVM, then CCTP to the Starknet vault', async () => {
  const env = await setup();
  await deposited(env);
  succeeds(await deliver(env, withdrawMsg(EXIT_ID, EXIT8)));
  eq(await liability(env, USDC), DEPOSIT6 * 100n - EXIT8);
  const expected = '0x0100000d' + abi.encode(
    ['address', 'address', 'uint32', 'uint32', 'uint64', 'uint64'],
    [addr(SYSTEM), addr(0), 0xffffffff, 0xffffffff, USDC, EXIT8]
  ).slice(2);
  eq(await lastAction(env), expected);

  reverts(await env.omnibus.call('burnExit', [EXIT_ID], STRANGER), 'ExitNotReady');
  // HyperCore executes the send: debits the account, pays out on the EVM.
  await env.spotBalance.call('debit', [env.omnibus.hex, USDC, EXIT8]);
  await env.usdc.call('mint', [env.wallet.hex, EXIT8 / 100n]);
  succeeds(await env.wallet.call('transfer', [env.omnibus.hex, EXIT8 / 100n], SYSTEM));

  succeeds(await env.omnibus.call('burnExit', [EXIT_ID], STRANGER));
  eq((await env.messenger.call('lastAmount')).decoded[0], EXIT8 / 100n);
  eq((await env.messenger.call('lastDomain')).decoded[0], 25n);
  eq((await env.messenger.call('lastMintRecipient')).decoded[0], EXIT_VAULT);
  eq((await env.messenger.call('lastDestinationCaller')).decoded[0], EXIT_VAULT);
  eq((await env.messenger.call('lastHookData')).decoded[0], EXIT_ID);
  reverts(await env.omnibus.call('burnExit', [EXIT_ID], STRANGER), 'ExitNotReady');
});

test('an exit must be whole CCTP units and backed by the ledger', async () => {
  const env = await setup();
  await deposited(env);
  reverts(await deliver(env, withdrawMsg(EXIT_ID, EXIT8 + 1n)), 'HV_EXIT_UNITS');
  // LiabilityUnderflow(uint64), bubbled up through the endpoint as raw data.
  reverts(await deliver(env, withdrawMsg(EXIT_ID, DEPOSIT6 * 100n + 100n)), ethers.id('LiabilityUnderflow(uint64)').slice(0, 10));
});

// ── Budgets, keeper fee, gates ──────────────────────────────────────────────

test('the keeper is paid from the instruction budget', async () => {
  const env = await setup();
  succeeds(await env.omnibus.call('setKeeperFee', [500n], OWNER));
  await deposited(env);
  // BUDGET delivered, LZ_FEE spent on CREDIT, 500 to whoever credited.
  eq((await env.omnibus.call('budget', [DEPOSIT_ID])).decoded[0], BUDGET - LZ_FEE - 500n);
  eq(await env.chain.balanceOf(addr(STRANGER)), 500n);
});

test('a budget can be topped up', async () => {
  const env = await setup();
  succeeds(await env.omnibus.call('fundBudget', [ROUTE], STRANGER, 777n));
  eq((await env.omnibus.call('budget', [ROUTE])).decoded[0], 777n);
});

test('only the endpoint, from the Starknet gateway, instructs', async () => {
  const env = await setup();
  reverts(
    await env.endpoint.call('deliver', [env.omnibus.hex, SN_EID, B32(0xbad), depositMsg(DEPOSIT_ID, 1n)], STRANGER),
    ethers.id('OnlyPeer(uint32,bytes32)').slice(0, 10)
  );
  reverts(
    await env.omnibus.call('lzReceive', [{ srcEid: SN_EID, sender: GATEWAY, nonce: 1 }, B32(1), depositMsg(DEPOSIT_ID, 1n), addr(STRANGER), '0x'], STRANGER),
    'OnlyEndpoint'
  );
});

test('only the owner configures, and the fee bound has a ceiling', async () => {
  const env = await setup();
  reverts(await env.omnibus.call('setKeeper', [addr(STRANGER)], STRANGER), 'NotOwner');
  reverts(await env.omnibus.call('setMaxFeeBps', [101], OWNER), 'BadConfig');
  succeeds(await env.omnibus.call('setAbstraction', [1], OWNER));
  eq(await lastAction(env), '0x01000010' + abi.encode(['address', 'uint8'], [env.omnibus.hex, 1]).slice(2));
});

run();
