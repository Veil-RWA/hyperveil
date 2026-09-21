// HyperVeil wire format, HyperEVM side. The hex vectors below are the SAME
// literals hyperveil/starknet/tests/test_codec.cairo asserts against the Cairo
// codec, so the two cannot drift without one of these suites failing.

const { Chain_, test, eq, reverts, run } = require('./harness');

const B32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

const DEPOSIT =
  '0x010000000000000000000000000000000000000000000000000123456789abcdef0000000000000000000000000ee6b280';
const PLACE =
  '0x020000000000000000000000000000000000000000000000000000000000000abc00000000000000000000000000000abc0000277b010000000095bea7e0000000003b9aca000200000000000000000000000000000096000000000000000000000005d9728ec00000000000000000000000003b9aca00000000000000000000000005d9728ec0';
const CANCEL = '0x030000000000000000000000000000000000000000000000000000000000000abc';
const WITHDRAW =
  '0x04000000000000000000000000000000000000000000000000000000000000e417000000000000000000000002540be400';
const CREDIT =
  '0x050000000000000000000000000000000000000000000000000123456789abcdef000000000000000000000005d1852380';
const FILL =
  '0x0600020000000000000000000000000000000000000000000000000000000000000abc0000000000000003000000000000000000000002cb4178000000000000000000000000001dcd6500000000000000000000000000000000000000000000000000000000000000000def0000000000000007000000000000000000000000000000000000000000000000000000000000000001';

const PLACE_VALUE = {
  routeId: B32(0xabc),
  cloid: 0xabcn,
  asset: 10107,
  isBuy: true,
  px: 2512300000n,
  sz: 1000000000n,
  tif: 2,
  offerToken: 0n,
  wantToken: 150n,
  offerAmount: 25123000000n,
  wantAmount: 1000000000n,
  escrow: 25123000000n,
};

const FILL_VALUE = [
  { routeId: B32(0xabc), seq: 3n, cumDraw: 12000000000n, cumDeliver: 500000000n, closed: false },
  { routeId: B32(0xdef), seq: 7n, cumDraw: 0n, cumDeliver: 0n, closed: true },
];

let codec;
async function c() {
  if (!codec) codec = await (await Chain_.create()).deploy('CodecHarness');
  return codec;
}

test('DEPOSIT matches the pinned vector and round-trips', async () => {
  const h = await c();
  eq((await h.call('encodeDeposit', [B32(0x0123456789abcdefn), 250000000n])).decoded[0], DEPOSIT);
  const d = (await h.call('decodeDeposit', [DEPOSIT])).decoded;
  eq(d[0], B32(0x0123456789abcdefn));
  eq(d[1], 250000000n);
});

test('PLACE matches the pinned vector and round-trips', async () => {
  const h = await c();
  eq((await h.call('encodePlace', [PLACE_VALUE])).decoded[0], PLACE);
  const p = (await h.call('decodePlace', [PLACE])).decoded[0];
  eq(p.routeId, PLACE_VALUE.routeId);
  eq(p.asset, 10107n);
  eq(p.isBuy, true);
  eq(p.px, PLACE_VALUE.px);
  eq(p.sz, PLACE_VALUE.sz);
  eq(p.tif, 2n);
  eq(p.wantToken, 150n);
  eq(p.escrow, PLACE_VALUE.escrow);
});

test('CANCEL, WITHDRAW and CREDIT match the pinned vectors', async () => {
  const h = await c();
  eq((await h.call('encodeCancel', [B32(0xabc)])).decoded[0], CANCEL);
  eq((await h.call('encodeWithdraw', [B32(0xe417), 10000000000n])).decoded[0], WITHDRAW);
  eq((await h.call('encodeCredit', [B32(0x0123456789abcdefn), 24990000000n])).decoded[0], CREDIT);
});

test('FILL matches the pinned vector and round-trips', async () => {
  const h = await c();
  eq((await h.call('encodeFill', [FILL_VALUE])).decoded[0], FILL);
  const items = (await h.call('decodeFill', [FILL])).decoded[0];
  eq(items.length, 2);
  eq(items[0].cumDraw, 12000000000n);
  eq(items[1].closed, true);
});

test('a truncated or mislabelled message is refused', async () => {
  const h = await c();
  reverts(await h.call('decodeDeposit', [DEPOSIT.slice(0, -2)]), 'BadLength');
  reverts(await h.call('decodeDeposit', [CREDIT]), 'BadKind');
  reverts(await h.call('decodeFill', [FILL.slice(0, -2)]), 'BadLength');
});

run();
