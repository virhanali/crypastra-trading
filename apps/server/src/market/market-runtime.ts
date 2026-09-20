import {
  DepthBook,
  MarketStateStore,
  type Candle,
  type Clock,
  type ConnectionState,
  type DepthUpdate,
  type MarketDataProvider,
  type MarketEvent,
  type StalenessPolicy,
} from "@crypastra/core";
import { LiveMarketSnapshotProvider } from "./live-market-snapshot-provider.js";

/**
 * Runtime pasar (Phase 6).
 *
 * Menyalurkan event pasar yang sudah dinormalkan dari `MarketDataProvider` ke:
 *   MarketState  →  buku kedalaman lokal (kontrak terpilih)  →  candle tertutup
 *   →  stream pasar EPHEMERAL (bukan outbox domain)
 *   →  pemroses risiko berkadens (coalesced)
 *
 * Semua efek ekonomi tetap dijalankan oleh `MarkToMarketService` melalui
 * `onRiskTick` yang disuntikkan; runtime ini tidak menghitung apa pun sendiri.
 *
 * Determinisme: seluruh perilaku adalah fungsi dari urutan event + `Clock`.
 */

export interface MarketRuntimeOptions {
  readonly provider: MarketDataProvider;
  readonly clock: Clock;
  readonly contracts: readonly string[];
  readonly candleInterval?: string;
  /** Kontrak yang MEMERLUKAN buku kedalaman lokal. Sisanya cukup book_ticker. */
  readonly depthContracts?: readonly string[];
  readonly staleness: StalenessPolicy;
  /**
   * Kadens pemrosesan risiko (ms). Mark masuk jauh lebih sering daripada ini;
   * hanya mark TERBARU yang diproses (coalescing), sehingga TP/SL/likuidasi
   * selalu memakai mark terakhir yang tersedia saat pemrosesan.
   */
  readonly riskIntervalMs?: number;
  /** Dipanggil oleh pemroses risiko; implementasi menyuntikkan MarkToMarketService. */
  readonly onRiskTick?: (contract: string, mark: unknown) => void;
  /** Emit event pasar ephemeral (tidak pernah durable). */
  readonly onMarketEvent?: (event: EphemeralMarketEvent) => void;
  /** Persistensi candle tertutup. */
  readonly onClosedCandle?: (candle: Candle) => void;
  /** Snapshot REST untuk bootstrap buku kedalaman (disediakan caller). */
  readonly fetchDepthSnapshot?: (contract: string) => Promise<{
    contract: string;
    updateId: number;
    bids: Array<{ price: string; size: number }>;
    asks: Array<{ price: string; size: number }>;
  }>;
}

export type EphemeralMarketEvent =
  | { type: "market.mark"; contract: string; timestamp: number; data: { markPrice: string; indexPrice: string | null; lastPrice: string | null; fundingRate: string | null } }
  | { type: "market.book"; contract: string; timestamp: number; data: { bestBid: string | null; bestAsk: string | null; bestBidSize: number | null; bestAskSize: number | null } }
  | { type: "market.candle"; contract: string; timestamp: number; data: { interval: string; openTime: number; close: string; closed: boolean } }
  | { type: "market.status"; contract: string; timestamp: number; data: { state: ConnectionState } };

export interface MarketRuntimeMetrics {
  tickerUpdates: number;
  bookTickerUpdates: number;
  depthUpdates: number;
  candleUpdates: number;
  bookResyncs: number;
  bookGapDetections: number;
  restSnapshotRequests: number;
  marksProcessed: number;
  marksCoalesced: number;
  riskEvaluations: number;
  marketEventsEmitted: number;
  marketEventsCoalesced: number;
  parseErrors: number;
}

export interface FeedHealth {
  readonly state: ConnectionState;
  readonly connectedSinceMs: number | null;
  readonly lastMessageAtMs: number | null;
  readonly lastTickerAtMs: number | null;
  readonly lastMarkAtMs: number | null;
  readonly lastBookAtMs: number | null;
  readonly lastCandleAtMs: number | null;
  readonly reconnectCount: number;
  readonly desiredSubscriptions: readonly string[];
  readonly activeSubscriptions: readonly string[];
  readonly staleContracts: readonly string[];
  readonly unsyncedBooks: readonly string[];
}

export class MarketRuntime {
  readonly #provider: MarketDataProvider;
  readonly #clock: Clock;
  readonly #state: MarketStateStore;
  readonly #depth = new Map<string, DepthBook>();
  readonly #depthContracts: Set<string>;
  readonly #staleness: StalenessPolicy;
  readonly #riskIntervalMs: number;
  readonly #candleInterval: string;
  readonly #onRiskTick: MarketRuntimeOptions["onRiskTick"];
  readonly #onMarketEvent: MarketRuntimeOptions["onMarketEvent"];
  readonly #onClosedCandle: MarketRuntimeOptions["onClosedCandle"];
  readonly #fetchDepthSnapshot: MarketRuntimeOptions["fetchDepthSnapshot"];

  readonly #metrics: MarketRuntimeMetrics = {
    tickerUpdates: 0,
    bookTickerUpdates: 0,
    depthUpdates: 0,
    candleUpdates: 0,
    bookResyncs: 0,
    bookGapDetections: 0,
    restSnapshotRequests: 0,
    marksProcessed: 0,
    marksCoalesced: 0,
    riskEvaluations: 0,
    marketEventsEmitted: 0,
    marketEventsCoalesced: 0,
    parseErrors: 0,
  };

  /** Mark terbaru yang belum diproses risiko, per kontrak (coalescing). */
  readonly #pendingRisk = new Map<string, unknown>();
  #riskTimer: ReturnType<typeof setInterval> | null = null;
  #connectedSinceMs: number | null = null;
  #lastTickerAtMs: number | null = null;
  #lastMarkAtMs: number | null = null;
  #lastBookAtMs: number | null = null;
  #lastCandleAtMs: number | null = null;
  #reconnectCount = 0;
  #unsubscribe: (() => void) | null = null;
  #running = false;

  constructor(options: MarketRuntimeOptions) {
    this.#provider = options.provider;
    this.#clock = options.clock;
    this.#state = new MarketStateStore(options.contracts);
    this.#depthContracts = new Set(options.depthContracts ?? []);
    this.#staleness = options.staleness;
    this.#riskIntervalMs = options.riskIntervalMs ?? 1000;
    this.#candleInterval = options.candleInterval ?? "5m";
    this.#onRiskTick = options.onRiskTick;
    this.#onMarketEvent = options.onMarketEvent;
    this.#onClosedCandle = options.onClosedCandle;
    this.#fetchDepthSnapshot = options.fetchDepthSnapshot;

    for (const contract of this.#depthContracts) {
      const book = new DepthBook(contract);
      book.beginSync();
      this.#depth.set(contract, book);
      this.#state.applyDepthView(contract, book.state());
    }
  }

  get state(): MarketStateStore {
    return this.#state;
  }

  /**
   * Clock yang disuntikkan. Replay memakainya untuk mengetahui waktu virtual
   * saat ini, sehingga perintah terjadwal memakai waktu pasar yang benar.
   */
  get clock(): Clock {
    return this.#clock;
  }

  /**
   * Pasang handler + langganan TANPA menunggu provider.
   *
   * Dipakai sumber in-memory (replay/simulasi) yang pengiriman event-nya
   * sinkron, sehingga pemutaran tidak memerlukan async sama sekali. Timer
   * pemroses risiko TIDAK dinyalakan: pemanggil yang memanggil `flushRisk()`
   * secara eksplisit pada setiap langkah.
   */
  attachProvider(): void {
    if (this.#unsubscribe !== null) {
      return;
    }
    this.#running = true;
    this.#unsubscribe = this.#provider.onEvent((event) => this.#handleEvent(event));
    this.#provider.onStateChange?.((state) => {
      if (state === "open") {
        this.#connectedSinceMs = this.#clock.nowMs();
      }
    });
  }

  marketProvider(): LiveMarketSnapshotProvider {
    return new LiveMarketSnapshotProvider({
      state: this.#state,
      clock: this.#clock,
      staleness: this.#staleness,
      depth: this.#depth,
    });
  }

  metricsSnapshot(): MarketRuntimeMetrics {
    return { ...this.#metrics };
  }

  /** Mulai: koneksi + langganan sesuai kelas (CORE/CANDLE/DEPTH). */
  async start(): Promise<void> {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#unsubscribe = this.#provider.onEvent((event) => this.#handleEvent(event));

    this.#provider.onStateChange?.((state, previous) => {
      if (state === "open") {
        this.#connectedSinceMs = this.#clock.nowMs();
        if (previous === "reconnecting") {
          this.#reconnectCount += 1;
          // Buku kedalaman tidak dapat dipercaya setelah putus.
          for (const [contract, book] of this.#depth) {
            book.markUnsynced(this.#clock.nowMs());
            this.#state.applyDepthView(contract, book.state());
            void this.#bootstrapDepth(contract);
          }
        }
      }
      for (const contract of this.#state.contracts()) {
        this.#emit({ type: "market.status", contract, timestamp: this.#clock.nowMs(), data: { state } });
      }
    });

    await this.#provider.connect();
    for (const contract of this.#state.contracts()) {
      await this.#provider.subscribeTicker(contract);
      await this.#provider.subscribeCandles(contract, this.#candleInterval);
      // Channel ringan untuk kutipan eksekusi; TIDAK memakai kedalaman penuh.
      await this.#provider.subscribeBookTicker?.(contract);
    }
    for (const contract of this.#depth.keys()) {
      await this.#provider.subscribeBook(contract);
    }
    // Snapshot REST hanya untuk kontrak yang butuh kedalaman.
    await Promise.all([...this.#depth.keys()].map((contract) => this.#bootstrapDepth(contract)));

    this.#riskTimer = setInterval(() => this.flushRisk(), this.#riskIntervalMs);
    if (typeof this.#riskTimer.unref === "function") {
      this.#riskTimer.unref();
    }
  }

  /** Hentikan seluruh timer dan koneksi; tidak meninggalkan timer reconnect. */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#riskTimer !== null) {
      clearInterval(this.#riskTimer);
      this.#riskTimer = null;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#pendingRisk.clear();
    await this.#provider.disconnect();
  }

  /**
   * Ambil snapshot REST lalu aktifkan buku. Dipanggil saat start dan saat resync
   * setelah gap/reconnect. Kegagalan REST membiarkan buku UNSYNCED (tanpa
   * eksekusi dari kedalaman) dan tidak melempar.
   */
  async #bootstrapDepth(contract: string): Promise<void> {
    const book = this.#depth.get(contract);
    if (book === undefined || this.#fetchDepthSnapshot === undefined) {
      return;
    }
    try {
      this.#metrics.restSnapshotRequests += 1;
      book.beginSync();
      const snapshot = await this.#fetchDepthSnapshot(contract);
      book.applySnapshot(snapshot, this.#clock.nowMs());
      this.#metrics.bookResyncs += 1;
    } catch {
      book.markUnsynced(this.#clock.nowMs());
    }
    this.#state.applyDepthView(contract, book.state());
  }

  /** Proses antrean risiko (mark terbaru per kontrak) — dipanggil timer. */
  flushRisk(): void {
    if (this.#pendingRisk.size === 0) {
      return;
    }
    const pending = [...this.#pendingRisk.entries()];
    this.#pendingRisk.clear();
    for (const [contract, mark] of pending) {
      this.#metrics.riskEvaluations += 1;
      this.#onRiskTick?.(contract, mark);
    }
  }

  feedHealth(): FeedHealth {
    return {
      state: this.#provider.state(),
      connectedSinceMs: this.#connectedSinceMs,
      lastMessageAtMs: this.#provider.lastMessageAtMs?.() ?? null,
      lastTickerAtMs: this.#lastTickerAtMs,
      lastMarkAtMs: this.#lastMarkAtMs,
      lastBookAtMs: this.#lastBookAtMs,
      lastCandleAtMs: this.#lastCandleAtMs,
      reconnectCount: this.#reconnectCount,
      desiredSubscriptions: this.#provider.desiredSubscriptions?.().tickers ?? [],
      activeSubscriptions: this.#provider.state() === "open" ? this.#state.contracts() : [],
      staleContracts: this.markStatuses().filter((entry) => entry.status !== "fresh").map((entry) => entry.contract),
      unsyncedBooks: [...this.#depth.entries()].filter(([, book]) => !book.isExecutable()).map(([contract]) => contract).sort(),
    };
  }

  markStatuses(): Array<{ contract: string; status: "fresh" | "stale" | "missing" }> {
    const provider = this.marketProvider();
    return this.#state.contracts().map((contract) => ({ contract, status: provider.markStatus(contract) }));
  }

  /** True bila seluruh kontrak yang dilacak punya mark segar dan buku sinkron. */
  isReady(): boolean {
    if (this.#provider.state() !== "open") {
      return false;
    }
    const provider = this.marketProvider();
    const marksFresh = this.#state
      .contracts()
      .every((contract) => provider.markStatus(contract) === "fresh");
    const booksSynced = [...this.#depth.values()].every((book) => book.isExecutable());
    return marksFresh && booksSynced;
  }

  #handleEvent(event: MarketEvent): void {
    switch (event.type) {
      case "ticker": {
        const ticker = event.ticker;
        this.#metrics.tickerUpdates += 1;
        this.#lastTickerAtMs = this.#clock.nowMs();
        this.#state.applyTicker({
          contract: ticker.contract,
          lastPrice: ticker.lastPrice,
          markPrice: ticker.markPrice,
          indexPrice: ticker.indexPrice,
          fundingRate: ticker.fundingRate,
          fundingNextApplySeconds: ticker.fundingNextApplySeconds,
          fundingIntervalSeconds: ticker.fundingIntervalSeconds,
          sourceTimestampMs: ticker.eventTsMs,
          receivedAtMs: this.#clock.nowMs(),
        });
        if (ticker.markPrice !== null && ticker.markPrice !== undefined) {
          this.#lastMarkAtMs = this.#clock.nowMs();
          this.#queueRisk(ticker.contract, ticker);
          this.#emit({
            type: "market.mark",
            contract: ticker.contract,
            timestamp: ticker.eventTsMs,
            data: {
              markPrice: String(ticker.markPrice),
              indexPrice: ticker.indexPrice === null ? null : String(ticker.indexPrice),
              lastPrice: String(ticker.lastPrice),
              fundingRate: ticker.fundingRate === null ? null : String(ticker.fundingRate),
            },
          });
        }
        return;
      }
      case "candle": {
        const candle = event.candle;
        this.#metrics.candleUpdates += 1;
        this.#lastCandleAtMs = this.#clock.nowMs();
        this.#state.applyCandle({ candle, receivedAtMs: this.#clock.nowMs() });
        if (candle.windowClosed) {
          this.#onClosedCandle?.(candle);
        }
        this.#emit({
          type: "market.candle",
          contract: candle.contract,
          timestamp: this.#clock.nowMs(),
          data: {
            interval: candle.interval,
            openTime: candle.openTimeSeconds,
            close: candle.c,
            closed: candle.windowClosed,
          },
        });
        return;
      }
      case "book_snapshot": {
        const snapshot = event.snapshot;
        const book = this.#depth.get(snapshot.contract);
        if (book === undefined) {
          return;
        }
        book.applySnapshot(snapshot, this.#clock.nowMs());
        this.#state.applyDepthView(snapshot.contract, book.state());
        return;
      }
      case "book_ticker": {
        const tick = event.bookTicker;
        this.#metrics.bookTickerUpdates += 1;
        this.#lastBookAtMs = this.#clock.nowMs();
        this.#state.applyBookTicker({
          contract: tick.contract,
          bestBid: tick.bestBid,
          bestBidSize: tick.bestBidSize,
          bestAsk: tick.bestAsk,
          bestAskSize: tick.bestAskSize,
          updateId: tick.updateId,
          sourceTimestampMs: tick.eventTsMs,
          receivedAtMs: this.#clock.nowMs(),
        });
        this.#emit({
          type: "market.book",
          contract: tick.contract,
          timestamp: tick.eventTsMs,
          data: {
            bestBid: tick.bestBid,
            bestBidSize: tick.bestBidSize,
            bestAsk: tick.bestAsk,
            bestAskSize: tick.bestAskSize,
          },
        });
        return;
      }
      case "book_update": {
        const update: MarketUpdateAlias = event.update;
        this.#metrics.depthUpdates += 1;
        // Kedalaman penuh hanya untuk kontrak yang dikonfigurasi.
        const book = this.#depth.get(update.contract);
        if (book !== undefined) {
          const before = book.status;
          const depthUpdate: DepthUpdate = {
            contract: update.contract,
            firstUpdateId: update.firstUpdateId,
            lastUpdateId: update.lastUpdateId,
            bids: update.bids,
            asks: update.asks,
          };
          book.applyUpdate(depthUpdate, this.#clock.nowMs());
          const after = book.status;
          if (before === "synced" && after === "unsynced") {
            this.#metrics.bookGapDetections += 1;
            void this.#bootstrapDepth(update.contract);
          }
          this.#state.applyDepthView(update.contract, book.state());
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Coalescing risiko: simpan HANYA mark terbaru per kontrak. Mark yang tertimpa
   * sebelum sempat diproses dihitung sebagai `marksCoalesced`.
   */
  #queueRisk(contract: string, mark: unknown): void {
    if (this.#pendingRisk.has(contract)) {
      this.#metrics.marksCoalesced += 1;
    } else {
      this.#metrics.marksProcessed += 1;
    }
    this.#pendingRisk.set(contract, mark);
  }

  #emit(event: EphemeralMarketEvent): void {
    this.#metrics.marketEventsEmitted += 1;
    this.#onMarketEvent?.(event);
  }
}

type MarketUpdateAlias = Extract<MarketEvent, { type: "book_update" }>["update"];
