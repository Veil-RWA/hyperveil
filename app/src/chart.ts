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
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import {
  DOWN,
  INTERVAL_MS,
  UP,
  candlesFor,
  priceDecimals,
  toBars,
  wsUrl,
  type HlCandle,
  type Interval,
} from "./chartData";

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
  private decimals = -1;
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
    this.candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } });
    // Volume on its own overlay scale along the bottom, as on Hyperliquid.
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    this.connect();
  }

  /** Shows `coin`. A no-op when it already does, apart from a price
   *  precision that only became known now (`px` arrives with the markets). */
  show(coin: string, szDecimals: number, px: number): void {
    const decimals = priceDecimals(px, szDecimals);
    if (decimals !== this.decimals) {
      this.decimals = decimals;
      this.candles.applyOptions({
        priceFormat: { type: "price", precision: decimals, minMove: 1 / 10 ** decimals },
      });
    }
    if (coin === this.coin) return;
    this.coin = coin;
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
        this.onEmpty(false);
      } catch {
        // Older than the last bar drawn (history landed after it): skip.
      }
    }
  }
}
