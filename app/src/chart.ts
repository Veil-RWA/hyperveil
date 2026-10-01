// The price chart on the trade page: Hyperliquid's own candles for the
// selected spot pair, drawn with TradingView's Lightweight Charts (Apache-2.0;
// it shows TradingView's attribution link, as its licence asks).
//
// History is one `candleSnapshot` request. After that the candle in progress
// streams over Hyperliquid's websocket (`candle` subscription), the feed
// Hyperliquid's own chart uses. Polling candles next to the book would spend
// the per-IP request budget the book and trades already draw on.

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
} from "lightweight-charts";
import {
  DOWN,
  INTERVAL_MS,
  UP,
  candlesFor,
  priceDecimals,
  toBars,
  wsUrl,
  type Bar,
  type HlCandle,
  type Interval,
} from "./chartData";
import { escapeHtml } from "./format";

/** Bars of history: plenty to scroll back through, far under the API's 5000. */
const HISTORY_BARS = 500;
/** Hyperliquid closes a connection that has been silent for a minute; a
 *  quiet testnet pair sends no candle for much longer than that. */
const PING_MS = 30_000;
const RECONNECT_MS = 3_000;

export class PriceChart {
  private readonly chart: IChartApi;
  private readonly candles: ISeriesApi<"Candlestick">;
  private readonly volume: ISeriesApi<"Histogram">;
  private coin: string | null = null;
  private label = "";
  private decimals = -1;
  /** The newest bar: what the legend shows while the crosshair is away. */
  private lastBar: Bar | null = null;
  /** Bumped on every change of pair or interval: an answer for an earlier
   *  one arrives late and is dropped. */
  private generation = 0;
  private ws: WebSocket | null = null;
  private subscribed: { coin: string; interval: Interval } | null = null;
  private pingTimer: number | undefined;
  private retryTimer: number | undefined;
  private closed = false;

  constructor(
    el: HTMLElement,
    private readonly api: string,
    private interval: Interval,
    /** Tells the page whether the range in view has any trades at all. */
    private readonly onEmpty: (empty: boolean) => void = () => {},
    /** Where the OHLC legend goes (top left of the chart, as on Hyperliquid). */
    private readonly legend?: HTMLElement,
  ) {
    this.chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#99a2b2",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: "#ffffff0a" }, horzLines: { color: "#ffffff0a" } },
      rightPriceScale: { borderColor: "#ffffff14" },
      timeScale: { borderColor: "#ffffff14", timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    // Room above the highest candle for the legend, which wraps on a phone.
    const top = el.clientWidth < 600 ? 0.16 : 0.08;
    this.candles.priceScale().applyOptions({ scaleMargins: { top, bottom: 0.26 } });
    // Volume on its own overlay scale along the bottom, as on Hyperliquid.
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    this.chart.subscribeCrosshairMove((p: MouseEventParams) => {
      const hovered = p.seriesData.get(this.candles) as CandlestickData | undefined;
      this.paintLegend(hovered && "open" in hovered ? (hovered as Bar) : this.lastBar);
    });
    this.connect();
  }

  /** Shows `coin`. A no-op when it already does, apart from a price
   *  precision that only became known now (`px` arrives with the markets). */
  show(coin: string, label: string, szDecimals: number, px: number): void {
    const decimals = priceDecimals(px, szDecimals);
    if (decimals !== this.decimals) {
      this.decimals = decimals;
      this.candles.applyOptions({
        priceFormat: { type: "price", precision: decimals, minMove: 1 / 10 ** decimals },
      });
      this.paintLegend(this.lastBar);
    }
    if (coin === this.coin) return;
    this.coin = coin;
    this.label = label;
    this.reload();
  }

  setInterval(interval: Interval): void {
    if (interval === this.interval) return;
    this.interval = interval;
    this.reload();
  }

  destroy(): void {
    this.closed = true;
    this.generation++;
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.chart.remove();
  }

  // ── History ────────────────────────────────────────────────────────────────

  private reload(): void {
    const generation = ++this.generation;
    this.candles.setData([]);
    this.volume.setData([]);
    this.lastBar = null;
    this.paintLegend(null);
    this.subscribe();
    void this.loadHistory(generation);
  }

  private async loadHistory(generation: number): Promise<void> {
    const coin = this.coin;
    if (!coin) return;
    const endTime = Date.now();
    const startTime = endTime - HISTORY_BARS * INTERVAL_MS[this.interval];
    let rows: HlCandle[];
    try {
      const res = await fetch(`${this.api.replace(/\/$/, "")}/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: this.interval, startTime, endTime } }),
      });
      if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
      rows = (await res.json()) as HlCandle[];
    } catch (e) {
      console.warn("candles", e);
      return;
    }
    if (generation !== this.generation || this.closed) return;
    const bars = rows.map(toBars);
    this.candles.setData(bars.map((b) => b.bar));
    this.volume.setData(bars.map((b) => b.volume));
    this.chart.timeScale().scrollToRealTime();
    this.lastBar = bars.length ? bars[bars.length - 1].bar : null;
    this.paintLegend(this.lastBar);
    this.onEmpty(bars.length === 0);
  }

  // ── Live candles ───────────────────────────────────────────────────────────

  private connect(): void {
    if (this.closed || this.ws) return;
    const ws = new WebSocket(wsUrl(this.api));
    this.ws = ws;
    this.subscribed = null;
    ws.onopen = () => {
      this.subscribe();
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: "ping" }));
      }, PING_MS);
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      if (!this.closed) this.retryTimer = window.setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  /** One subscription at a time: the pair and interval on screen. */
  private subscribe(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.coin) return;
    const want = { coin: this.coin, interval: this.interval };
    const had = this.subscribed;
    if (had && had.coin === want.coin && had.interval === want.interval) return;
    if (had) ws.send(JSON.stringify({ method: "unsubscribe", subscription: { type: "candle", ...had } }));
    ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "candle", ...want } }));
    this.subscribed = want;
  }

  private onMessage(raw: unknown): void {
    if (!this.coin) return;
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    for (const c of candlesFor(message, this.coin, this.interval)) {
      const { bar, volume } = toBars(c);
      try {
        this.candles.update(bar);
        this.volume.update(volume);
        if (!this.lastBar || bar.time >= this.lastBar.time) {
          this.lastBar = bar;
          this.paintLegend(bar);
        }
        this.onEmpty(false);
      } catch {
        // Older than the last bar drawn (history landed after it): skip.
      }
    }
  }

  // ── Legend ─────────────────────────────────────────────────────────────────

  /** "HYPE/USDC · 15m · Hyperliquid  O 29.40 H 29.62 L 29.31 C 29.55 +0.15 (+0.51%)" */
  private paintLegend(bar: Bar | null): void {
    if (!this.legend) return;
    const title = `<span class="lg-title">${escapeHtml(this.label)} · ${this.interval} · Hyperliquid</span>`;
    if (!bar) {
      this.legend.innerHTML = title;
      return;
    }
    const d = Math.max(0, this.decimals);
    const f = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    const diff = bar.close - bar.open;
    const tone = diff >= 0 ? "buy" : "sell";
    const pctChange = bar.open ? (diff / bar.open) * 100 : 0;
    const sign = diff >= 0 ? "+" : "";
    this.legend.innerHTML = `${title}
      <span>O<b class="${tone}">${f(bar.open)}</b></span>
      <span>H<b class="${tone}">${f(bar.high)}</b></span>
      <span>L<b class="${tone}">${f(bar.low)}</b></span>
      <span>C<b class="${tone}">${f(bar.close)}</b></span>
      <b class="${tone}">${sign}${f(diff)} (${sign}${pctChange.toFixed(2)}%)</b>`;
  }
}
