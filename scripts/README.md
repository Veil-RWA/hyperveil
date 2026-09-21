# Deploying HyperVeil

Testnet runbook: **HyperEVM testnet (chain 998, eid 40362)** and **Starknet
Sepolia (eid 40500)**. Every script is resumable — addresses are written to
`../deployments/<evm>__<starknet>.json` as soon as they exist, so a failure at
step 5 does not mean paying for steps 1–4 again — and every wiring script is
idempotent.

```bash
cd hyperveil/scripts
npm install
cp .env.example .env     # then fill it in
set -a && . ./.env && set +a
```

## What you need first

| | Why |
|---|---|
| A **HyperEVM account with HYPE** | gas. Testnet: claim 1000 mock USDC at [app.hyperliquid-testnet.xyz/drip](https://app.hyperliquid-testnet.xyz/drip) (only an address that has deposited on **mainnet** can claim), buy HYPE on the testnet spot market, then send it to `0x2222222222222222222222222222222222222222` to move it to HyperEVM. |
| That account **on HyperCore** | the big-block flag is a HyperCore user flag. The faucet gives you the account. |
| A **Starknet account with STRK** | deploys and owns the pool, the gateway, the twins and the KYC list. |
| **Sepolia USDC** | to actually move value: [faucet.circle.com](https://faucet.circle.com) mints Circle's USDC on Starknet Sepolia (`0x0512feAc…8343`) — 20 USDC every 2 hours, per address. The app links to it. |
| A **SNIP-36 prover** that knows `venue_fill` | fills cannot be applied without it. |

Everything else — LayerZero endpoints and libraries, Circle's CCTP contracts,
the `CoreDepositWallet` — is pinned in `config.js`, with the source and the
date it was read.

## 1. HyperEVM: the omnibus

```bash
node deploy-hyperevm.js
```

The omnibus is ~18.5 KB of runtime code, so deploying it needs more gas than a
HyperEVM **small block** allows (3M, one a second). The script switches the
deployer to **big blocks** (30M, one a minute) with an `evmUserModify` L1
action, deploys, waits for a big block, and switches back.

Then **activate the omnibus's HyperCore account**: nothing it sends through
CoreWriter runs until that account exists. Send it USDC on HyperCore (a spot
send from the Hyperliquid app is enough):

```
<the omnibus address the script printed>
```

On testnet this may not work for a freshly deployed contract address —
[hyperliquid-dex/node#138](https://github.com/hyperliquid-dex/node/issues/138)
reports `depositFor` silently failing to create one. `wire.js` checks the
account again and tells you.

## 2. Starknet: the pool and everything around it

```bash
(cd ../.. && scarb build) && (cd ../starknet && scarb build)
node deploy-starknet.js --tokens PURR --auditor-key 0x<stark curve x>
```

Deploys, in order: a `VeilERC3643Factory` with the current pool class and
**HyperVeil's own pool** (a pool has exactly one exchange and one venue, so it
cannot share the main one), the KYC permission manager, the gateway, one twin
per HyperCore token, the KYC rules for real USDC and STRK, the entry helper,
the exit vault, the fee adapter and — with `STRK20_POOL` set — the STRK20
entry.

`--tokens` takes HyperCore tickers. They are resolved against the live info
API, so each twin's decimals are the token's own `weiDecimals`. USDC (token 0)
is always included. `--auditor-key` is the pool's auditor public key: it has no
setter, so it is fixed at deployment.

## 3. Wire both sides

```bash
node wire.js --keeper-evm 0x<evm keeper> --keeper-sn 0x<starknet keeper>
node wire.js --check            # reads both chains; exits non-zero if not wired
```

Peers, twins, the keeper, the entry helper, the exit vault, the fee bound, the
gas each side asks for, the pool's tokens (twins allowlisted; USDC and STRK as
rules tokens), the venue, every adapter, the exchange, and the KYC list entries
the contracts themselves need.

Setting one side's peer and sending immediately is the classic way to strand a
message — this does both sides.

## 4. Pin who verifies the messages

```bash
node configure-dvns.js
node configure-dvns.js --check
```

On the testnet pathway **LayerZero Labs is the only DVN that runs on both
chains**, so it is the default set there; on mainnet nine providers qualify and
the default is LayerZero Labs + Nethermind. Optional DVNs are "none", not "the
default".

## 5. Write the app's and the keeper's configuration

```bash
node write-config.js --prover https://<prover> --intake http://localhost:8787 \
  --kyc http://localhost:8788 --return-value <HYPE wei>
```

Writes `../app/public/deployment.json`, `../keeper/.env` and the addresses in
`../kyc/.env` from the same deployment file, so they cannot disagree about the
contracts or about `return_value` — the HYPE each instruction carries to pay
the omnibus's reply. `--kyc` is where the KYC service answers; it also becomes
that service's OAuth redirect URI (with `/callback` on the end), which has to
match what is registered with the provider exactly.

**`--return-value 0` does not work in production.** With 0 the omnibus's CREDIT
and FILL revert with `BudgetTooLow`. Quote a LayerZero delivery on HyperEVM,
use a number above it, and keep the app and the keeper on the same one.

Add the two keeper keys to `../keeper/.env` by hand (`SN_KEEPER_PRIVATE_KEY`,
`EVM_KEEPER_PRIVATE_KEY`). The Starknet keeper account is the pool's exchange:
it proves crossings and venue fills.

## 6. KYC

The allowlist gates the twins **and** the real USDC and STRK inside HyperVeil's
pool: an account that is not on it cannot hold, deposit or receive any of them.

**On testnet it is open.** `write-config.js` sets `HV_OPEN_ALLOWLIST=1` in the
keeper's environment, which turns on `POST /allowlist` on the intake: the app
asks for a connecting wallet, and the keeper's next tick puts it on the list
(its account is the permission manager's whitelister). The keeper refuses the
flag outright on mainnet, and `--no-open-allowlist` turns it off here. There is
nothing for a tester to do but connect.

By hand, which still works and is the only way with the flag off:

```bash
node whitelist.js --account 0x<starknet account>
node whitelist.js --account 0x<starknet account> --check
```

## 7. Run it

```bash
(cd ../keeper && npm install && npm start)
(cd ../app && npm install && npm run dev)     # http://localhost:5176
```

Then, in the app: add USDC to Veil (from your wallet, or from STRK20), add a
little STRK the same way (it pays the messages), send USDC to Hyperliquid,
trade, and bring it back.

## Checking a live deployment

```bash
node wire.js --check
node configure-dvns.js --check
```

A message that does not arrive: take the transaction to
[testnet.layerzeroscan.com](https://testnet.layerzeroscan.com). Stuck in
`VERIFYING` is the DVN configuration; stuck after verification is usually
delivery gas — the gas each side asks for is in `config.js`
(`GATEWAY_GAS`, `OMNIBUS_GAS`), measured rather than guessed.
