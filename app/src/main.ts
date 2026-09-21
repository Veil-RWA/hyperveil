// HyperVeil app: boot, navigation, and the polling that keeps market data and
// account state fresh. Views live in ./views.

import { inject } from "@vercel/analytics";
import { S, connect, disconnect, onRerender, refreshAccount, restore } from "./app";
import { CIRCLE_FAUCET, deployment, hasTestnetFaucet, isDeployed, loadDeployment } from "./config";
import { escapeHtml, short } from "./format";
import { HyperliquidInfo } from "./market";
import { renderDeposit, renderWithdraw, pollDeposit, pollWithdraw } from "./views/funds";
import { pollPortfolio, renderPortfolio, updatePortfolio } from "./views/portfolio";
import { pickDefaultMarket, renderTrade, updateTrade } from "./views/trade";
import { restoreWallet } from "./wallet";
import type { Tab } from "./app";

const TABS: Tab[] = ["trade", "portfolio", "deposit", "withdraw"];
const view = () => document.getElementById("view")!;

function tabFromHash(): Tab {
  const h = location.hash.replace("#", "") as Tab;
  return TABS.includes(h) ? h : "trade";
}

function show(tab: Tab): void {
  S.tab = tab;
  document.querySelectorAll<HTMLButtonElement>("#tabs .tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  const root = view();
  if (tab === "trade") renderTrade(root);
  else if (tab === "portfolio") renderPortfolio(root);
  else if (tab === "deposit") renderDeposit(root);
  else renderWithdraw(root);
}

function renderNav(): void {
  const el = document.getElementById("nav-right")!;
  const net = `<span class="chip">${deployment().network === "testnet" ? "Testnet" : "Mainnet"}</span>`;
  if (!S.session) {
    el.innerHTML = `${net}<button class="btn btn-gold" id="nav-connect">Connect wallet</button>`;
    document.getElementById("nav-connect")!.addEventListener("click", () => void connect());
    return;
  }
  const kyc =
    !S.deployed ? "" :
    S.kyc === true ? `<span class="chip chip-good"><span class="dot"></span>KYC approved</span>` :
    S.allowlisting ? `<span class="chip">Enabling this account…</span>` :
    S.kyc === false ? `<span class="chip chip-bad"><span class="dot"></span>Not approved</span>` :
    `<span class="chip">KYC …</span>`;
  // Testnet: USDC is the first thing a new wallet needs, so the way to get
  // some lives in the header rather than inside a form. It is Circle's own
  // faucet — the only USDC that CCTP will carry to Hyperliquid.
  const faucet = hasTestnetFaucet()
    ? `<a class="btn btn-gold" id="nav-faucet" href="${CIRCLE_FAUCET}" target="_blank" rel="noopener noreferrer">Claim USDC faucet</a>`
    : "";
  el.innerHTML = `${net}${kyc}${faucet}
    <button class="btn btn-ghost" id="nav-account" title="Disconnect">${escapeHtml(short(S.session.address))}</button>`;
  document.getElementById("nav-account")!.addEventListener("click", () => void disconnect());
}

function renderNotice(): void {
  const el = document.getElementById("notice")!;
  if (!S.deployed) {
    el.className = "notice";
    el.textContent = "HyperVeil's contracts are not deployed on this network yet. Market data is live; trading, deposits and withdrawals open at launch.";
    el.hidden = false;
    return;
  }
  el.hidden = true;
}

/** Account or data changed: redraw what depends on it, keeping inputs. */
function rerender(): void {
  renderNav();
  if (S.tab === "trade") updateTrade();
  else if (S.tab === "portfolio") updatePortfolio();
  else if (S.tab === "deposit" || S.tab === "withdraw") {
    // These forms are small; redraw unless the user is typing in them.
    const active = document.activeElement as HTMLElement | null;
    if (!active || active.tagName !== "INPUT") show(S.tab);
  }
}

// ── Polling ─────────────────────────────────────────────────────────────────

async function pollMarkets(): Promise<void> {
  if (!S.info) return;
  try {
    S.markets = await S.info.markets();
    pickDefaultMarket();
    if (S.tab === "trade") updateTrade();
  } catch (e) {
    console.warn("markets", e);
  }
}

async function pollBook(): Promise<void> {
  if (!S.info || !S.coin || S.tab !== "trade" || document.hidden) return;
  const coin = S.coin;
  try {
    const [book, trades] = await Promise.all([S.info.book(coin), S.info.trades(coin)]);
    if (coin !== S.coin) return;
    S.book = book;
    S.trades = trades;
    S.marketAt = Date.now();
    updateTrade();
  } catch (e) {
    console.warn("book", e);
  }
}

function pollAccount(): void {
  if (!S.session || document.hidden) return;
  void refreshAccount();
  if (S.tab === "portfolio") pollPortfolio();
  if (S.tab === "deposit") pollDeposit();
  if (S.tab === "withdraw") pollWithdraw();
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  try {
    await loadDeployment();
  } catch (e) {
    view().innerHTML = `<div class="panel card"><h2>Configuration missing</h2><p class="muted">${escapeHtml((e as Error).message)}</p></div>`;
    return;
  }
  S.deployed = isDeployed();
  S.info = new HyperliquidInfo(deployment().hyperliquid.api);
  document.getElementById("foot-net")!.textContent = deployment().network === "testnet" ? "Starknet Sepolia · Hyperliquid testnet" : "Starknet · Hyperliquid";

  onRerender(rerender);
  document.querySelectorAll<HTMLButtonElement>("#tabs .tab").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab as Tab)));
  window.addEventListener("hashchange", () => show(tabFromHash()));

  renderNotice();
  renderNav();
  show(tabFromHash());

  await pollMarkets();
  void pollBook();
  window.setInterval(() => void pollMarkets(), 15_000);
  window.setInterval(() => void pollBook(), 2_500);
  window.setInterval(pollAccount, 30_000);

  const session = await restoreWallet();
  if (session) await restore(session);
}

void boot();

// Initialize Vercel Web Analytics
inject();
