import {
  type Clock,
  type ConnectionState,
  type ContractSpec,
  type MarketDataProvider,
  type MarketEventHandler,
  type MarketEvent,
  type Candle,
} from "@crypastra/core";
import WebSocket from "ws";
import {
  intervalToSeconds,
  toBookTicker,
  toBookSnapshot,
  toBookUpdate,
  toCandles,
  toContractSpec,
  toTicker,
  toTrades,
  type GateContractPayload,
  type GateCandlePayload,
} from "./parse.js";

export { intervalToSeconds } from "./parse.js";
export * from "./parse.js";

export const GATE_REST_BASE = "https://api.gateio.ws/api/v4";
export const GATE_WS_BASE = "wss://fx-ws.gateio.ws/v4/ws/usdt";

interface GateWsMessage {
  time?: number;
  channel?: string;
  event?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface GateioProviderOptions {
  readonly restBase?: string;
  readonly wsBase?: string;
  readonly clock?: Clock;
  readonly requestTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  /** Backoff reconnect (ms). Attempt ke-n menunggu base * 2^(n-1), dibatasi max. */
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  /** Timer yang dapat disuntik supaya reconnect dapat diuji deterministik. */
  readonly timers?: {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export interface GateioMetrics {
  readonly wsConnections: number;
  readonly wsReconnects: number;
  readonly wsMessages: number;
  readonly wsParseErrors: number;
  readonly reconnectsScheduled: number;
  readonly lastMessageAgeMs: number | null;
  readonly reconnectAttempt: number;
}

const SYSTEM_CLOCK: Clock = { nowMs: () => Date.now() };

/**
 * Provider market data Gate.io USDT perpetual.
 *
 * Semua fakta protokol di sini diverifikasi empiris — lihat
 * docs/gateio-market-data.md. Yang penting:
 *  - mark price TIDAK punya channel WS; ia datang dari `futures.tickers`.
 *  - ping dikirim client lewat channel `futures.ping`, balasan `futures.pong`.
 */
export class GateioMarketDataProvider implements MarketDataProvider {
  readonly id = "gateio";
  readonly mode = "live" as const;
  readonly clock: Clock;

  readonly #restBase: string;
  readonly #wsBase: string;
  readonly #timeoutMs: number;
  readonly #pingIntervalMs: number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;
  readonly #timers: { setTimeout(handler: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };

  /** Keinginan langganan TIDAK bergantung pada socket: sumber kebenaran resubscribe. */
  readonly #desiredTickers = new Set<string>();
  readonly #desiredCandles = new Map<string, string>();
  readonly #desiredTrades = new Set<string>();
  readonly #desiredBooks = new Set<string>();
  readonly #desiredBookTickers = new Set<string>();
  #manualClose = false;
  #reconnectAttempt = 0;
  #reconnectTimer: unknown = null;
  #lastMessageAtMs: number | null = null;
  #metrics = { wsConnections: 0, wsReconnects: 0, wsMessages: 0, wsParseErrors: 0, reconnectsScheduled: 0 };
  readonly #stateHandlers = new Set<(state: ConnectionState, previous: ConnectionState) => void>();

  #ws: WebSocket | null = null;
  #state: ConnectionState = "idle";
  readonly #handlers = new Set<MarketEventHandler>();
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  readonly #contractCache = new Map<string, ContractSpec>();
  readonly #markSeenAt = new Map<string, number>();

  constructor(options: GateioProviderOptions = {}) {
    this.#restBase = options.restBase ?? GATE_REST_BASE;
    this.#wsBase = options.wsBase ?? GATE_WS_BASE;
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#pingIntervalMs = options.pingIntervalMs ?? 20_000;
    this.#reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.#reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.#timers = options.timers ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  state(): ConnectionState {
    return this.#state;
  }

  onStateChange(
    handler: (state: ConnectionState, previous: ConnectionState) => void,
  ): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  #setState(next: ConnectionState): void {
    const previous = this.#state;
    if (previous === next) {
      return;
    }
    this.#state = next;
    for (const handler of this.#stateHandlers) {
      try {
        handler(next, previous);
      } catch (error) {
        console.error("[gateio] state handler error:", error);
      }
    }
  }

  onEvent(handler: MarketEventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  #broadcast(event: MarketEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[gateio] handler error:", error);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.#ws !== null) {
      return;
    }
    this.#manualClose = false;
    this.#setState(this.#reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.#wsBase);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        this.#setState("open");
        this.#metrics.wsConnections += 1;
        // Koneksi stabil: backoff direset dan langganan dipulihkan.
        this.#reconnectAttempt = 0;
        this.#resubscribeAll();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        this.#setState("closed");
        this.#ws = null;
        reject(error);
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    ws.on("message", (data: WebSocket.RawData) => this.#onMessage(data));
    ws.on("close", () => {
      this.#stopPing();
      this.#ws = null;
      if (this.#manualClose) {
        this.#setState("closed");
        return;
      }
      this.#scheduleReconnect();
    });
    ws.on("error", (error: Error) => {
      console.error("[gateio] ws error:", error.message);
    });

    this.#startPing();
  }

  /**
   * Reconnect dengan backoff eksponensial terbatas, tanpa loop rapat.
   * Langganan yang diinginkan dipertahankan terpisah dari socket, jadi
   * reconnect berikutnya tidak pernah menggandakan langganan logis.
   */
  #scheduleReconnect(): void {
    if (this.#manualClose || this.#reconnectTimer !== null) {
      return;
    }
    this.#reconnectAttempt += 1;
    const delay = Math.min(this.#reconnectBaseMs * 2 ** (this.#reconnectAttempt - 1), this.#reconnectMaxMs);
    this.#setState("reconnecting");
    this.#metrics.reconnectsScheduled += 1;
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#metrics.wsReconnects += 1;
      void this.connect().catch((error: unknown) => {
        console.error("[gateio] reconnect gagal:", error instanceof Error ? error.message : error);
        this.#scheduleReconnect();
      });
    }, delay);
  }

  /** Kirim ulang seluruh langganan yang diinginkan setelah socket terbuka. */
  #resubscribeAll(): void {
    for (const contract of this.#desiredTickers) {
      this.#send("futures.tickers", "subscribe", [contract]);
    }
    for (const [contract, interval] of this.#desiredCandles) {
      this.#send("futures.candlesticks", "subscribe", [interval, contract]);
    }
    for (const contract of this.#desiredTrades) {
      this.#send("futures.trades", "subscribe", [contract]);
    }
    for (const contract of this.#desiredBookTickers) {
      this.#send("futures.book_ticker", "subscribe", [contract]);
    }
    for (const contract of this.#desiredBooks) {
      this.#send("futures.order_book_update", "subscribe", [contract, "1000ms", "5"]);
    }
  }

  /** Langganan yang diinginkan (independen dari status socket). */
  desiredSubscriptions(): {
    tickers: string[];
    candles: Array<{ contract: string; interval: string }>;
    trades: string[];
    books: string[];
    bookTickers: string[];
  } {
    return {
      tickers: [...this.#desiredTickers].sort(),
      candles: [...this.#desiredCandles].map(([contract, interval]) => ({ contract, interval })),
      trades: [...this.#desiredTrades].sort(),
      books: [...this.#desiredBooks].sort(),
      bookTickers: [...this.#desiredBookTickers].sort(),
    };
  }

  metrics(): GateioMetrics {
    const last = this.#lastMessageAtMs;
    return {
      ...this.#metrics,
      lastMessageAgeMs: last === null ? null : this.clock.nowMs() - last,
      reconnectAttempt: this.#reconnectAttempt,
    };
  }

  lastMessageAtMs(): number | null {
    return this.#lastMessageAtMs;
  }

  async disconnect(): Promise<void> {
    this.#manualClose = true;
    this.#stopPing();
    if (this.#reconnectTimer !== null) {
      this.#timers.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    if (ws === null) {
      this.#setState("closed");
      return;
    }
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
    this.#setState("closed");
  }

  #startPing(): void {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#send("futures.ping", "subscribe", []);
      }
    }, this.#pingIntervalMs);
  }

  #stopPing(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #send(channel: string, event: string, payload: unknown[]): void {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket Gate.io belum terhubung");
    }
    ws.send(
      JSON.stringify({
        time: Math.floor(this.clock.nowMs() / 1000),
        channel,
        event,
        payload,
      }),
    );
  }

  async subscribeTicker(contract: string): Promise<void> {
    if (this.#desiredTickers.has(contract)) {
      return; // dedupe: tidak ada langganan logis ganda
    }
    this.#desiredTickers.add(contract);
    this.#send("futures.tickers", "subscribe", [contract]);
  }

  async subscribeCandles(contract: string, interval: string): Promise<void> {
    if (this.#desiredCandles.get(contract) === interval) {
      return;
    }
    this.#desiredCandles.set(contract, interval);
    this.#send("futures.candlesticks", "subscribe", [interval, contract]);
  }

  async subscribeTrades(contract: string): Promise<void> {
    if (this.#desiredTrades.has(contract)) {
      return;
    }
    this.#desiredTrades.add(contract);
    this.#send("futures.trades", "subscribe", [contract]);
  }

  /** Channel RINGAN `futures.book_ticker`: sumber kutipan eksekusi utama. */
  async subscribeBookTicker(contract: string): Promise<void> {
    if (this.#desiredBookTickers.has(contract)) {
      return;
    }
    this.#desiredBookTickers.add(contract);
    this.#send("futures.book_ticker", "subscribe", [contract]);
  }

  async subscribeBook(contract: string): Promise<void> {
    if (this.#desiredBooks.has(contract)) {
      return;
    }
    this.#desiredBooks.add(contract);
    this.#send("futures.order_book_update", "subscribe", [contract, "1000ms", "5"]);
  }

  async unsubscribe(contract: string): Promise<void> {
    this.#send("futures.tickers", "unsubscribe", [contract]);
  }

  #onMessage(data: WebSocket.RawData): void {
    this.#metrics.wsMessages += 1;
    this.#lastMessageAtMs = this.clock.nowMs();
    let message: GateWsMessage;
    try {
      message = JSON.parse(String(data)) as GateWsMessage;
    } catch {
      this.#metrics.wsParseErrors += 1;
      console.error("[gateio] pesan non-JSON diabaikan");
      return;
    }

    if (message.channel === "futures.pong") {
      return;
    }
    if (message.event === "subscribe" || message.event === "unsubscribe") {
      if (message.error !== undefined) {
        console.error(`[gateio] subscribe gagal (${message.channel}): ${message.error.message}`);
      }
      return;
    }
    if (message.event !== "update") {
      return;
    }

    const now = this.clock.nowMs();
    switch (message.channel) {
      case "futures.tickers": {
        if (!Array.isArray(message.result)) {
          return;
        }
        for (const item of message.result) {
          const ticker = toTicker(item, now);
          if (ticker !== null) {
            this.#markSeenAt.set(ticker.contract, ticker.eventTsMs);
            this.#broadcast({ type: "ticker", ticker });
          }
        }
        return;
      }
      case "futures.candlesticks": {
        for (const candle of toCandles(message.result)) {
          this.#broadcast({ type: "candle", candle });
        }
        return;
      }
      case "futures.trades": {
        for (const trade of toTrades(message.result, now)) {
          this.#broadcast({ type: "trade", trade });
        }
        return;
      }
      case "futures.book_ticker": {
        const raw = message.result;
        const bookTicker = toBookTicker(
          typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {},
          now,
        );
        if (bookTicker !== null) {
          this.#broadcast({ type: "book_ticker", bookTicker });
        }
        return;
      }
      case "futures.order_book_update": {
        const update = toBookUpdate(message.result, now);
        if (update !== null) {
          this.#broadcast({ type: "book_update", update });
        }
        return;
      }
      case "futures.order_book": {
        const snapshot = toBookSnapshot(message.result, now);
        if (snapshot !== null) {
          this.#broadcast({ type: "book_snapshot", snapshot });
        }
        return;
      }
      default:
        return;
    }
  }

  async loadContract(contract: string): Promise<ContractSpec> {
    const cached = this.#contractCache.get(contract);
    if (cached !== undefined) {
      return cached;
    }
    const payload = await this.#rest<GateContractPayload>(
      `/futures/usdt/contracts/${encodeURIComponent(contract)}`,
    );
    const spec = toContractSpec(payload, contract);
    this.#contractCache.set(contract, spec);
    return spec;
  }

  async loadCandles(contract: string, interval: string, limit: number): Promise<Candle[]> {
    const payload = await this.#rest<GateCandlePayload[]>(
      `/futures/usdt/candlesticks?contract=${encodeURIComponent(contract)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
    );
    const nowSeconds = Math.floor(this.clock.nowMs() / 1000);
    const intervalSeconds = intervalToSeconds(interval);
    return payload.map((row) => ({
      contract,
      interval,
      openTimeSeconds: row.t,
      o: row.o,
      h: row.h,
      l: row.l,
      c: row.c,
      v: row.v,
      sum: row.sum ?? "0",
      // REST tidak memberi flag `w`; candle dianggap tertutup bila window-nya
      // sudah lewat. Ini assumption A13 — lihat docs/gateio-market-data.md.
      windowClosed: row.t + intervalSeconds <= nowSeconds,
    }));
  }

  markPriceAgeMs(contract: string): number | null {
    const seen = this.#markSeenAt.get(contract);
    return seen === undefined ? null : this.clock.nowMs() - seen;
  }

  async #rest<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#restBase}${path}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Gate.io REST ${path} gagal: HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}