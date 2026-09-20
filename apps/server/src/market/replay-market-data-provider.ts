import {
  observationToEvents,
  virtualClock,
  type BookSnapshot,
  type Candle,
  type Clock,
  type ConnectionState,
  type ContractSpec,
  type MarketDataProvider,
  type MarketEventHandler,
  type MarketObservation,
  type Ticker,
} from "@crypastra/core";

/**
 * Provider pasar untuk REPLAY (Phase 8).
 *
 * Memenuhi interface `MarketDataProvider` yang sama dengan provider live,
 * sehingga `MarketRuntime`, `MarketState`, `MarkToMarketService`, dan Paper
 * Exchange TIDAK tahu apakah sumbernya LIVE atau REPLAY. Tidak ada
 * "ReplayExchange"/"ReplayPnLCalculator" — mesin ekonominya tetap satu.
 *
 * Observasi yang sudah direkam TIDAK di-parse ulang dari payload Gate: ia
 * diubah menjadi event ternormalisasi lewat `observationToEvents`, fungsi yang
 * sama yang dipakai jalur live.
 */

export type ReplayState = "idle" | "running" | "paused" | "completed" | "failed";

/** Pacing hanya mengubah waktu dinding; TIDAK mengubah hasil ekonomi. */
export type ReplaySpeed = "step" | "max" | "1x" | "10x" | "100x";

export interface ReplayProgress {
  readonly state: ReplayState;
  readonly processed: number;
  readonly total: number;
  readonly virtualTimeMs: number;
}

export interface ReplayProviderOptions {
  readonly observations: readonly MarketObservation[];
  readonly clock?: Clock & { set(ms: number): void };
  readonly speed?: ReplaySpeed;
  readonly contract?: ContractSpec;
  /** Delay antar observasi pada mode 1x/10x/100x (ms), hanya untuk demo. */
  readonly wallClockBaseMs?: number;
}

export class ReplayMarketDataProvider implements MarketDataProvider {
  readonly id = "replay";
  readonly mode = "replay" as const;
  readonly clock: Clock & { set(ms: number): void };

  readonly #observations: readonly MarketObservation[];
  readonly #speed: ReplaySpeed;
  readonly #handlers = new Set<MarketEventHandler>();
  readonly #stateHandlers = new Set<(state: ConnectionState, previous: ConnectionState) => void>();
  readonly #spec: ContractSpec | null;
  readonly #baseDelayMs: number;

  #state: ReplayState = "idle";
  #cursor = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #tickers = new Map<string, Ticker>();
  readonly #books = new Map<string, BookSnapshot>();
  #lastMessageAtMs: number | null = null;

  constructor(options: ReplayProviderOptions) {
    this.#observations = options.observations;
    this.#speed = options.speed ?? "max";
    this.#spec = options.contract ?? null;
    this.#baseDelayMs = options.wallClockBaseMs ?? 1000;
    this.clock =
      options.clock ??
      (virtualClock(0) as Clock & { set(ms: number): void });
  }

  // ── state ──────────────────────────────────────────────────────

  state(): ConnectionState {
    if (this.#state === "idle") return "idle";
    if (this.#state === "running") return "open";
    if (this.#state === "paused") return "degraded";
    if (this.#state === "completed") return "closed";
    return "closed";
  }

  replayState(): ReplayState {
    return this.#state;
  }

  progress(): ReplayProgress {
    return {
      state: this.#state,
      processed: this.#cursor,
      total: this.#observations.length,
      virtualTimeMs: this.clock.nowMs(),
    };
  }

  onEvent(handler: MarketEventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  onStateChange(handler: (state: ConnectionState, previous: ConnectionState) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  lastMessageAtMs(): number | null {
    return this.#lastMessageAtMs;
  }

  desiredSubscriptions() {
    return { tickers: [], candles: [], trades: [], books: [], bookTickers: [] };
  }

  // ── lifecycle ──────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.#state = "running";
  }

  async disconnect(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#state = "completed";
  }

  async subscribeTicker(): Promise<void> {}
  async subscribeCandles(): Promise<void> {}
  async subscribeTrades(): Promise<void> {}
  async subscribeBookTicker(): Promise<void> {}
  async subscribeBook(): Promise<void> {}
  async unsubscribe(): Promise<void> {}

  async loadContract(): Promise<ContractSpec> {
    if (this.#spec === null) {
      throw new Error("Replay tidak menyediakan spesifikasi kontrak");
    }
    return this.#spec;
  }

  async loadCandles(): Promise<Candle[]> {
    return [];
  }

  // ── replay ─────────────────────────────────────────────────────

  /**
   * Putar SATU observasi berikutnya secara sinkron.
   *
   * VirtualClock di-set ke `observedAtMs` observasi tersebut SEBELUM diproses.
   * Alasan: live menghitung staleness sebagai `clock.nowMs() − sourceTimestampMs`
   * dengan clock lokal saat observasi diterima, dan `observedAtMs` persis nilai
   * itu. Memakai `sourceTimestampMs` akan membuat staleness selalu 0 dan
   * menyembunyikan gap yang nyata.
   */
  stepOnce(): MarketObservation | null {
    if (this.#cursor >= this.#observations.length) {
      this.#state = "completed";
      return null;
    }
    const observation = this.#observations[this.#cursor]!;
    this.#cursor += 1;
    // Urutan kanonik adalah `seq`, sedangkan waktu observasi bisa tidak monoton
    // (mis. dua kanal berbeda dengan jam sumber berbeda, atau rekaman tak
    // terurut). VirtualClock tidak boleh mundur, jadi waktu dibawa ke nilai
    // tertinggi — observasi tetap diproses PADA URUTANNYA, hanya waktunya
    // di-clamp. Ini didokumentasikan sebagai perilaku eksplisit untuk data
    // tak terurut (bukan data yang dikarang).
    const targetTime = Math.max(this.clock.nowMs(), observation.observedAtMs);
    if (targetTime !== this.clock.nowMs()) {
      this.clock.set(targetTime);
    } else if (this.#cursor === 1) {
      // Observasi pertama: set dari nilai awal clock.
      this.clock.set(observation.observedAtMs);
    }
    this.#lastMessageAtMs = this.clock.nowMs();
    this.#applyToState(observation);
    for (const event of observationToEvents(observation)) {
      this.#broadcast(event);
    }
    if (this.#cursor >= this.#observations.length) {
      this.#state = "completed";
    }
    return observation;
  }

  /** Putar seluruh observasi secepat mungkin (hasil identik dengan STEP). */
  async runToCompletion(): Promise<number> {
    let count = 0;
    while (this.stepOnce() !== null) {
      count += 1;
    }
    return count;
  }

  pause(): void {
    if (this.#state === "running") {
      this.#state = "paused";
    }
  }

  resume(): void {
    if (this.#state === "paused") {
      this.#state = "running";
      this.#scheduleNext();
    }
  }

  /** Mulai dengan pacing (mode ber-paced). MAX tetap memakai `runToCompletion`. */
  async start(): Promise<void> {
    this.#state = "running";
    if (this.#speed === "max" || this.#speed === "step") {
      await this.runToCompletion();
      return;
    }
    this.#scheduleNext();
  }

  #scheduleNext(): void {
    if (this.#state !== "running") {
      return;
    }
    const delay = this.#delayFor(this.#speed);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.stepOnce() === null) {
        return;
      }
      this.#scheduleNext();
    }, delay);
    if (typeof this.#timer.unref === "function") {
      this.#timer.unref();
    }
  }

  #delayFor(speed: ReplaySpeed): number {
    if (speed === "1x") return this.#baseDelayMs;
    if (speed === "10x") return this.#baseDelayMs / 10;
    if (speed === "100x") return this.#baseDelayMs / 100;
    return 0;
  }

  #broadcast(event: Parameters<MarketEventHandler>[0]): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[replay] handler error:", error);
      }
    }
  }

  /**
   * Cache keadaan terakhir supaya `getMark`/`getBook` (bila dipakai langsung)
   * tidak pernah mengembalikan data masa depan atau data yang belum terjadi.
   */
  /** Mark terakhir yang SUDAH terjadi (tidak pernah data masa depan). */
  getMark(contract: string): { markPrice: string; stale?: boolean } | null {
    const ticker = this.#tickers.get(contract);
    if (ticker === undefined) {
      return null;
    }
    return { markPrice: String(ticker.markPrice ?? ticker.lastPrice) };
  }

  /** Top-of-book terakhir yang SUDAH terjadi; null bila sisi tidak lengkap. */
  getBook(contract: string): BookSnapshot | null {
    return this.#books.get(contract) ?? null;
  }

  #applyToState(observation: MarketObservation): void {
    for (const event of observationToEvents(observation)) {
      if (event.type === "ticker") {
        this.#tickers.set(event.ticker.contract, event.ticker);
      } else if (event.type === "book_ticker") {
        const tick = event.bookTicker;
        const previous = this.#books.get(tick.contract);
        this.#books.set(tick.contract, {
          contract: tick.contract,
          updateId: previous?.updateId ?? 0,
          eventTsMs: tick.eventTsMs,
          bids: tick.bestBid === null ? [] : [{ price: tick.bestBid, size: tick.bestBidSize ?? 0 }],
          asks: tick.bestAsk === null ? [] : [{ price: tick.bestAsk, size: tick.bestAskSize ?? 0 }],
        });
      }
    }
  }
}
