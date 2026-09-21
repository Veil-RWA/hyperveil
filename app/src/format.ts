// Display helpers. Amounts stay bigint end to end; nothing here uses floats
// for anything but a price shown to the eye.

export function short(address: string, lead = 6, tail = 4): string {
  if (!address) return "";
  return address.length <= lead + tail + 2 ? address : `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** A base-unit integer as a decimal string, grouped, trailing zeros dropped. */
export function units(value: bigint, decimals: number, maxFraction = 6): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? "." + frac : ""}`;
}

/** A price string from the Hyperliquid API, trimmed for display. */
export function price(px: string | number | undefined): string {
  if (px === undefined || px === "") return "—";
  const n = Number(px);
  if (!Number.isFinite(n)) return String(px);
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toPrecision(5).replace(/0+$/, "").replace(/\.$/, "");
}

export function compactUsd(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

export function pct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
}

export function ago(timestamp: number): string {
  const s = (Date.now() - timestamp) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const hex = (v: bigint | number): string => "0x" + BigInt(v).toString(16);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
