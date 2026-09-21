#!/usr/bin/env node
// Give the omnibus a HyperCore account, out of USDC sitting on Starknet.
//
//   node fund-omnibus-core.js [--amount 3] [--send 2] [--standard] [--sn-tx 0x…]
//
// Nothing on HyperCore works for an account that does not exist: CoreWriter
// actions are dropped, and `creditDeposit` never sees a balance, so a deposit
// that has already crossed sits uncredited. An account comes into existence by
// being spot-sent something. This walks the value there:
//
//   1. Starknet   burn USDC through Circle CCTP to the deployer's EVM address
//   2. Circle     wait for the attestation (standard finality: minutes)
//   3. HyperEVM   receive it — USDC is minted to the deployer
//   4. HyperEVM   deposit it into HyperCore through Circle's CoreDepositWallet
//   5. HyperCore  spot-send USDC to the omnibus, which creates its account
//
// Resumable: the Starknet burn is the only irreversible step, so after it the
// script prints its hash and `--sn-tx 0x…` picks up from the attestation.
//
// Testnet only, and it spends the deployer's own USDC.

const { ethers } = require('ethers');
const { network } = require('./config');
const {
  parseArgs, loadDeployment, requireEnv, starknetAccount, snCall, snSend, hex, u256, step, done,
} = require('./lib');
const hl = require('./hl');

/// `type(uint32).max` — HyperCore's spot dex (evm/contracts/hyperliquid/HyperCore.sol).
const SPOT_DEX = 4294967295;
/// CCTP V2 finality thresholds. Standard (2000) from Starknet waits for the zk
/// proof to finalize on Ethereum — Circle's own table says 2 to 4 hours. Fast
/// (1000) is ~20 seconds and costs 14 bps from Starknet, so this uses fast and
/// caps the fee generously; `--standard` takes the slow, free route.
const FAST_FINALITY = 1000;
const STANDARD_FINALITY = 2000;
const MAX_FEE_BPS = 20n;
const HYPEREVM_DOMAIN = 19;
const STARKNET_DOMAIN = 25;

const usdc6 = (v) => BigInt(Math.round(Number(v) * 1e6));
const asUsdc = (v) => (Number(v) / 1e6).toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attestation(irisUrl, txHash) {
  const url = `${irisUrl}/v2/messages/${STARKNET_DOMAIN}?transactionHash=${txHash}`;
  for (let i = 0; i < 360; i++) {
    const res = await fetch(url).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    const m = (body.messages || [])[0];
    if (m && m.attestation && m.attestation !== 'PENDING' && m.status === 'complete') return m;
    process.stdout.write(`\r      waiting for Circle… ${i * 5}s${m ? ` (${m.status})` : ''}   `);
    await sleep(5_000);
  }
  throw new Error('Circle did not attest the burn in 30 minutes (standard finality takes 2-4 hours from Starknet — resume with --sn-tx)');
}

async function main() {
  const args = parseArgs(process.argv);
  const snNet = network(args.starknet);
  const evmNet = network(args.evm);
  if (String(args.starknet).endsWith('mainnet')) throw new Error('testnet only');
  const d = loadDeployment(args);
  const omnibus = d.evm.omnibus;
  if (!omnibus) throw new Error('no omnibus in the deployment file');

  const amount = usdc6(args.amount ?? 3);
  const send = usdc6(args.send ?? 2);
  const finality = args.standard ? STANDARD_FINALITY : FAST_FINALITY;
  const maxFee = finality === FAST_FINALITY ? (amount * MAX_FEE_BPS + 9999n) / 10000n : 0n;
  if (send > amount) throw new Error('--send cannot exceed --amount');

  const [snAddress, snKey] = requireEnv('SN_ACCOUNT_ADDRESS', 'SN_PRIVATE_KEY');
  const [evmKey] = requireEnv('EVM_PRIVATE_KEY');
  const { provider, account } = starknetAccount(process.env.SN_RPC_URL || snNet.rpc, snAddress, snKey);
  const evm = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL || evmNet.rpc);
  const wallet = new ethers.Wallet(evmKey, evm);

  console.log(`omnibus   ${omnibus}`);
  console.log(`you (evm) ${wallet.address}`);
  console.log(`routing   ${asUsdc(amount)} USDC, sending ${asUsdc(send)} of it to the omnibus`);
  console.log(`cctp      ${finality === FAST_FINALITY ? `fast, fee up to ${asUsdc(maxFee)} USDC` : 'standard (2-4 hours)'}\n`);

  // ── 1. Burn on Starknet ────────────────────────────────────────────────────
  let snTx = args['sn-tx'];
  step(1, 5, 'Starknet: burn USDC to your EVM address (CCTP)');
  if (snTx) {
    done('skipped', `resuming from ${snTx}`);
  } else {
    const held = BigInt((await snCall(provider, snNet.usdc, 'balance_of', [snAddress]))[0]);
    if (held < amount) throw new Error(`you hold ${asUsdc(held)} USDC on Starknet, need ${asUsdc(amount)}`);
    snTx = await snSend(
      account, provider, 'approve + deposit_for_burn', snNet.usdc, 'approve',
      [snNet.tokenMessenger, ...u256(amount)], snNet.explorer,
    );
    snTx = await snSend(
      account, provider, 'deposit_for_burn', snNet.tokenMessenger, 'deposit_for_burn',
      [
        ...u256(amount),
        String(HYPEREVM_DOMAIN),
        ...u256(BigInt(wallet.address)),
        snNet.usdc,
        ...u256(0n),
        ...u256(maxFee),
        String(finality),
      ],
      snNet.explorer,
    );
  }

  // ── 2. Circle attests ──────────────────────────────────────────────────────
  step(2, 5, 'Circle: wait for the attestation');
  const { message, attestation: sig } = await attestation(
    process.env.IRIS_API_URL || 'https://iris-api-sandbox.circle.com', snTx,
  );
  process.stdout.write('\r');
  done('attested', `${message.length / 2} bytes of message`);

  // ── 3. Receive on HyperEVM ────────────────────────────────────────────────
  step(3, 5, 'HyperEVM: receive the USDC');
  const usdc = new ethers.Contract(evmNet.usdc, [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ], wallet);
  const before = await usdc.balanceOf(wallet.address);
  const transmitter = new ethers.Contract(evmNet.messageTransmitter, [
    'function receiveMessage(bytes,bytes) returns (bool)',
  ], wallet);
  const rx = await (await transmitter.receiveMessage(message, sig)).wait();
  const arrived = (await usdc.balanceOf(wallet.address)) - before;
  done('received', `${asUsdc(arrived)} USDC (${rx.hash})`);
  if (arrived === 0n) throw new Error('nothing arrived — the message may already have been received');

  // ── 4. Into HyperCore ─────────────────────────────────────────────────────
  step(4, 5, 'HyperEVM -> HyperCore: deposit through Circle');
  await (await usdc.approve(evmNet.coreDepositWallet, arrived)).wait();
  const core = new ethers.Contract(evmNet.coreDepositWallet, [
    'function deposit(uint256,uint32)',
  ], wallet);
  const dep = await (await core.deposit(arrived, SPOT_DEX)).wait();
  done('deposited', dep.hash);
  // HyperCore carries USDC at 8 dp; CCTP at 6. Hence the factor of 100.
  let mine = 0n;
  for (let i = 0; i < 40; i++) {
    mine = (await hl.spotBalance(evm, wallet.address, 0).catch(() => ({ total: 0n }))).total;
    if (mine / 100n >= send) break;
    process.stdout.write(`\r      waiting for HyperCore… ${i * 5}s   `);
    await sleep(5000);
  }
  process.stdout.write('\r');
  done('on HyperCore', `${asUsdc(mine / 100n)} USDC`);

  // ── 5. Create the omnibus's account ───────────────────────────────────────
  step(5, 5, 'HyperCore: spot-send to the omnibus');
  const tokens = await hl.info(evmNet.hlApi, { type: 'spotMeta' });
  const meta = tokens.tokens.find((t) => t.name === 'USDC');
  await hl.spotSend(evmNet.hlApi, wallet, omnibus, `USDC:${meta.tokenId}`, asUsdc(send), false);
  for (let i = 0; i < 20; i++) {
    if (await hl.coreUserExists(evm, omnibus)) break;
    await sleep(3000);
  }
  const exists = await hl.coreUserExists(evm, omnibus);
  done('omnibus account', exists ? 'EXISTS' : 'still missing');

  console.log(exists
    ? '\nDone. Now run: node wire.js   (it sets the omnibus account mode)\n'
    : '\nThe send went through but HyperCore has not shown the account yet; check again shortly.\n');
}

main().catch((e) => {
  console.error('\n' + String(e.message || e));
  process.exit(1);
});
