import { afterEach, describe, expect, test } from "bun:test";
import {
  Decimal,
  virtualClock,
  type Candle,
  type ConnectionState,
  type ContractSpec,
  type MarketDataProvider,
  type MarketEventHandler,
} from "../packages/core/src/index.js";
import { MarketRuntime } from "../apps/server/src/market/market-runtime.js";
import { LiveMarketSnapshotProvider } from "../apps/server/src/market/live-market-snapshot-provider.js";
import { LiveRiskProcessor } from "../apps/server/src/market/live-risk-processor.js";
import { MarkToMarketService } from "../apps/server/src/services/mark-to-market-service.js";
import { PositionRepository } from "../apps/server/src/repositories/position-repository.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";
import { createAccountViaApi, injectMarket, setupApi, type ApiHarness } from "./helpers/api.js";
import { BTC_USDT } from "./helpers/fixtures.js";
import { AccountRepository } from "../apps/server/src/repositories/account-repository.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import type { MarketSnapshotProvider } from "../apps/server/src/market/market-snapshot-provider.js";

const harnesses: ApiHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

/** Provider palsu deterministik: kita kendalikan event dan status koneksi. */
class FakeProvider implements MarketDataProvider {
  readonly id = "fake";
  readonly mode = "live" as const;
  clock = virtualClock(0);
  #handlers = new Set<MarketEventHandler>();
  #stateHandlers = new Set<(state: ConnectionState, previous: ConnectionState) => void>();
  #state: ConnectionState = "idle";
  #lastMessageAt: number | null = null;
  readonly subscribed: string[] = [];
  readonly desired = { tickers: [] as string[], candles: [] as Array<{ contract: string; interval: string }>, trades: [], books: [], bookTickers: [] as string[] };

  state(): ConnectionState {
    return this.#state;
  }
  onEvent(handler: MarketEventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  onStateChange(handler: (s: ConnectionState, p: ConnectionState) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }
  lastMessageAtMs(): number | null {
    return this.#lastMessageAt;
  }
  desiredSubscriptions() {
    return { ...this.desired, tickers: [...this.desired.tickers] };
  }
  async connect(): Promise<void> {
    this.#setState("open");
  }
  async disconnect(): Promise<void> {
    this.#setState("closed");
  }
  async subscribeTicker(contract: string): Promise<void> {
    this.subscribed.push(`ticker:${contract}`);
    this.desired.tickers.push(contract);
  }
  async subscribeCandles(contract: string, interval: string): Promise<void> {
    this.subscribed.push(`candle:${contract}:${interval}`);
    this.desired.candles.push({ contract, interval });
  }
  async subscribeTrades(): Promise<void> {}
  async subscribeBookTicker(contract: string): Promise<void> {
    this.subscribed.push(`bookTicker:${contract}`);
    this.desired.bookTickers.push(contract);
  }
  async subscribeBook(contract: string): Promise<void> {
    this.subscribed.push(`depth:${contract}`);
    this.desired.books.push(contract);
  }
  async unsubscribe(): Promise<void> {}
  async loadContract(): Promise<ContractSpec> {
    return BTC_USDT;
  }
  async loadCandles(): Promise<Candle[]> {
    return [];
  }

  #setState(next: ConnectionState): void {
    const previous = this.#state;
    this.#state = next;
    for (const handler of this.#stateHandlers) {
      handler(next, previous);
    }
  }

  emit(event: Parameters<MarketEventHandler>[0]): void {
    this.#lastMessageAt = this.clock.nowMs();
    for (const handler of this.#handlers) {
      handler(event);
    }
  }

  ticker(input: { contract: string; lastPrice: string; markPrice: string; indexPrice: string; fundingRate?: string | null; fundingNextApply?: number | null; fundingInterval?: number | null; tsMs: number }): void {
    this.emit({
      type: "ticker",
      ticker: {
        contract: input.contract,
        lastPrice: input.lastPrice,
        markPrice: input.markPrice,
        indexPrice: input.indexPrice,
        fundingRate: input.fundingRate ?? null,
        fundingRateIndicative: input.fundingRate ?? null,
        fundingNextApplySeconds: input.fundingNextApply ?? null,
        fundingIntervalSeconds: input.fundingInterval ?? null,
        eventTsMs: input.tsMs,
      },
    });
  }

  bookTicker(input: { contract: string; bid: string | null; bidSize: number | null; ask: string | null; askSize: number | null; tsMs: number; updateId?: number }): void {
    this.emit({
      type: "book_ticker",
      bookTicker: {
        contract: input.contract,
        bestBid: input.bid,
        bestBidSize: input.bidSize,
        bestAsk: input.ask,
        bestAskSize: input.askSize,
        updateId: input.updateId ?? 1,
        eventTsMs: input.tsMs,
      },
    });
  }

  depthUpdate(input: { contract: string; firstUpdateId: number; lastUpdateId: number; bids: Array<{ price: string; size: number }>; asks: Array<{ price: string; size: number }>; tsMs: number }): void {
    this.emit({
      type: "book_update",
      update: {
        contract: input.contract,
        firstUpdateId: input.firstUpdateId,
        lastUpdateId: input.lastUpdateId,
        eventTsMs: input.tsMs,
        bids: input.bids,
        asks: input.asks,
      },
    });
  }

  candle(input: { contract: string; t: number; close: string; windowClosed: boolean }): void {
    this.emit({
      type: "candle",
      candle: {
        contract: input.contract,
        interval: "5m",
        openTimeSeconds: input.t,
        o: input.close,
        h: input.close,
        l: input.close,
        c: input.close,
        v: 1,
        sum: "1",
        windowClosed: input.windowClosed,
      },
    });
  }

  simulateReconnect(): void {
    this.#setState("reconnecting");
    this.#setState("open");
  }
}

function makeRuntime(overrides: Partial<Parameters<typeof MarketRuntime>[0]> = {}): {
  provider: FakeProvider;
  runtime: MarketRuntime;
  emitted: Array<{ type: string; contract: string; data: unknown }>;
  closedCandles: Candle[];
} {
  const provider = new FakeProvider();
  const clock = virtualClock(1_700_000_000_000);
  provider.clock = clock;
  const emitted: Array<{ type: string; contract: string; data: unknown }> = [];
  const closedCandles: Candle[] = [];
  const runtime = new MarketRuntime({
    provider,
    clock,
    contracts: ["BTC_USDT"],
    depthContracts: overrides.depthContracts ?? [],
    staleness: { maxStalenessMs: 5000 },
    riskIntervalMs: 1000,
    onMarketEvent: (event) => emitted.push({ type: event.type, contract: event.contract, data: event.data }),
    onClosedCandle: (candle) => closedCandles.push(candle),
    ...overrides,
  });
  return { provider, runtime, emitted, closedCandles };
}

describe("6 & 7 & 8. ticker, book ticker, dan snapshot provider", () => {
  test("mark, last, dan index tetap berbeda (tidak disubstitusi)", async () => {
    const { provider, runtime } = makeRuntime();
    await runtime.start();
    provider.ticker({ contract: "BTC_USDT", lastPrice: "80000", markPrice: "80045.5", indexPrice: "80090.1", tsMs: 1 });

    const mark = runtime.marketProvider().getMark("BTC_USDT")!;
    const state = runtime.state.get("BTC_USDT")!;
    expect(state.lastPrice!.toString()).toBe("80000");
    expect(mark.markPrice).toBe("80045.5");
    expect(state.indexPrice!.toString()).toBe("80090.1");
    await runtime.stop();
  });

  test("funding diteruskan ke snapshot provider", async () => {
    const { provider, runtime } = makeRuntime();
    await runtime.start();
    provider.ticker({
      contract: "BTC_USDT",
      lastPrice: "80000",
      markPrice: "80000",
      indexPrice: "80000",
      fundingRate: "-0.000054",
      fundingNextApply: 1789920000,
      fundingInterval: 28800,
      tsMs: 1,
    });
    const mark = runtime.marketProvider().getMark("BTC_USDT")!;
    expect(mark.funding!.fundingRate).toBe("-0.000054");
    expect(mark.funding!.fundingTimestampMs).toBe(1789920000000);
    await runtime.stop();
  });

  test("buku hanya tersedia bila KEDUA sisi ada", async () => {
    const { provider, runtime } = makeRuntime();
    await runtime.start();
    provider.bookTicker({ contract: "BTC_USDT", bid: "79999", bidSize: 5, ask: null, askSize: null, tsMs: 1 });
    expect(runtime.marketProvider().getBook("BTC_USDT")).toBeNull();

    provider.bookTicker({ contract: "BTC_USDT", bid: "79999", bidSize: 5, ask: "80001", askSize: 3, tsMs: 2 });
    const book = runtime.marketProvider().getBook("BTC_USDT")!;
    expect(book.bids[0]).toEqual({ price: "79999", size: 5 });
    expect(book.asks[0]).toEqual({ price: "80001", size: 3 });
    await runtime.stop();
  });

  test("mark tanpa data → null (bukan ditebak dari last)", async () => {
    const { provider, runtime } = makeRuntime();
    await runtime.start();
    // Ticker tanpa mark (markPrice diisi last oleh adapter, jadi di sini kita
    // uji kontrak yang belum punya ticker sama sekali).
    expect(runtime.marketProvider().getMark("BTC_USDT")).toBeNull();
    provider.ticker({ contract: "BTC_USDT", lastPrice: "1", markPrice: "2", indexPrice: "3", tsMs: 1 });
    expect(runtime.marketProvider().getMark("BTC_USDT")).not.toBeNull();
    await runtime.stop();
  });
});

describe("9 & 10 & 11. kedalaman lokal", () => {
  test("bootstrap dari REST lalu SYNCED; eksekusi memakai buku", async () => {
    const snapshot = {
      contract: "BTC_USDT",
      updateId: 100,
      bids: [{ price: "79999", size: 5 }],
      asks: [{ price: "80001", size: 5 }],
    };
    const { provider, runtime } = makeRuntime({
      depthContracts: ["BTC_USDT"],
      fetchDepthSnapshot: async () => snapshot,
    });
    await runtime.start();
    provider.depthUpdate({ contract: "BTC_USDT", firstUpdateId: 101, lastUpdateId: 101, bids: [{ price: "79998", size: 2 }], asks: [], tsMs: 1 });

    const book = runtime.marketProvider().getBook("BTC_USDT")!;
    expect(book.bids.map((level) => level.price)).toEqual(["79999", "79998"]);
    expect(runtime.feedHealth().unsyncedBooks).toEqual([]);
    await runtime.stop();
  });

  test("gap → buku UNSYNCED, eksekusi diblokir, resync REST dipicu", async () => {
    let snapshots = 0;
    const { provider, runtime } = makeRuntime({
      depthContracts: ["BTC_USDT"],
      fetchDepthSnapshot: async () => {
        snapshots += 1;
        return { contract: "BTC_USDT", updateId: 200, bids: [{ price: "79990", size: 1 }], asks: [{ price: "80010", size: 1 }] };
      },
    });
    await runtime.start();
    expect(snapshots).toBe(1);
    provider.depthUpdate({ contract: "BTC_USDT", firstUpdateId: 201, lastUpdateId: 201, bids: [], asks: [], tsMs: 1 });

    // Lompat jauh → gap.
    provider.depthUpdate({ contract: "BTC_USDT", firstUpdateId: 500, lastUpdateId: 500, bids: [], asks: [], tsMs: 2 });
    expect(runtime.metricsSnapshot().bookGapDetections).toBe(1);
    // Resync dipicu (async) → tunggu microtask berikutnya.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(snapshots).toBeGreaterThanOrEqual(2);
    await runtime.stop();
  });

  test("kontrak tanpa konfigurasi kedalaman tidak berlangganan order_book_update", async () => {
    const { provider, runtime } = makeRuntime();
    await runtime.start();
    expect(provider.subscribed.some((entry) => entry.startsWith("depth:"))).toBe(false);
    expect(provider.subscribed.some((entry) => entry.startsWith("bookTicker:"))).toBe(true);
    await runtime.stop();
  });
});

describe("12. candle", () => {
  test("candle tertutup dipersist, candle berjalan tidak", async () => {
    const { provider, runtime, closedCandles } = makeRuntime();
    await runtime.start();
    provider.candle({ contract: "BTC_USDT", t: 100, close: "80000", windowClosed: false });
    expect(closedCandles).toHaveLength(0);
    provider.candle({ contract: "BTC_USDT", t: 100, close: "80010", windowClosed: true });
    expect(closedCandles).toHaveLength(1);
    await runtime.stop();
  });

  test("parsing 5m_BTC_USDT tetap benar lewat adapter (regresi Phase 0)", async () => {
    const { toCandles } = await import("../packages/adapters/src/gateio/parse.js");
    const candles = toCandles([{ t: 1, o: "1", h: "1", l: "1", c: "1", v: 1, n: "5m_BTC_USDT", w: true }]);
    expect(candles[0]!.contract).toBe("BTC_USDT");
    expect(candles[0]!.interval).toBe("5m");
    // w=true berarti window SUDAH tertutup.
    expect(candles[0]!.windowClosed).toBe(true);
  });
});

describe("2 & 3 & 4. koneksi dan langganan", () => {
  test("langganan di-dedupe dan dipulihkan setelah reconnect", async () => {
    const { provider, runtime } = makeRuntime();
    await runtime.start();
    const before = provider.subscribed.length;
    // Reconnect: runtime harus memulihkan langganan yang DIINGINKAN.
    provider.simulateReconnect();
    expect(runtime.feedHealth().reconnectCount).toBe(1);
    // Tanpa menggandakan langganan logis.
    expect(provider.desiredSubscriptions().tickers).toEqual(["BTC_USDT"]);
    expect(provider.subscribed.length).toBe(before);
    await runtime.stop();
  });

  test("buku ditandai UNSYNCED setelah reconnect", async () => {
    const { provider, runtime } = makeRuntime({
      depthContracts: ["BTC_USDT"],
      fetchDepthSnapshot: async () => ({ contract: "BTC_USDT", updateId: 1, bids: [{ price: "1", size: 1 }], asks: [{ price: "2", size: 1 }] }),
    });
    await runtime.start();
    provider.depthUpdate({ contract: "BTC_USDT", firstUpdateId: 2, lastUpdateId: 2, bids: [], asks: [], tsMs: 1 });
    expect(runtime.feedHealth().unsyncedBooks).toEqual([]);
    provider.simulateReconnect();
    // Setelah putus, kedalaman tidak boleh dipercaya.
    expect(runtime.metricsSnapshot().bookResyncs).toBeGreaterThanOrEqual(1);
    await runtime.stop();
  });
});

describe("20. staleness", () => {
  test("mark segar → risk tick dijalankan; mark basi → tidak", async () => {
    const clock = virtualClock(1_000_000);
    const provider = new FakeProvider();
    provider.clock = clock;
    const ticks: string[] = [];
    const runtime = new MarketRuntime({
      provider,
      clock,
      contracts: ["BTC_USDT"],
      staleness: { maxStalenessMs: 5000 },
      riskIntervalMs: 1000,
      onRiskTick: (contract) => ticks.push(contract),
    });
    await runtime.start();

    provider.ticker({ contract: "BTC_USDT", lastPrice: "1", markPrice: "100", indexPrice: "100", tsMs: clock.nowMs() });
    runtime.flushRisk();
    expect(ticks).toEqual(["BTC_USDT"]);
    expect(runtime.marketProvider().markStatus("BTC_USDT")).toBe("fresh");

    // Waktu berjalan tanpa update → mark menjadi basi.
    clock.advance(20_000);
    expect(runtime.marketProvider().markStatus("BTC_USDT")).toBe("stale");

    // Update baru → segar kembali.
    provider.ticker({ contract: "BTC_USDT", lastPrice: "1", markPrice: "101", indexPrice: "101", tsMs: clock.nowMs() });
    expect(runtime.marketProvider().markStatus("BTC_USDT")).toBe("fresh");
    await runtime.stop();
  });

  test("coalescing: banyak mark hanya menghasilkan satu pemrosesan per kontrak", async () => {
    const clock = virtualClock(0);
    const provider = new FakeProvider();
    provider.clock = clock;
    const seen: string[] = [];
    const runtime = new MarketRuntime({
      provider,
      clock,
      contracts: ["BTC_USDT"],
      staleness: { maxStalenessMs: 5000 },
      riskIntervalMs: 1000,
      onRiskTick: (_contract, mark) => seen.push((mark as { markPrice: string }).markPrice),
    });
    await runtime.start();
    for (let i = 0; i < 20; i += 1) {
      provider.ticker({ contract: "BTC_USDT", lastPrice: "1", markPrice: String(100 + i), indexPrice: "1", tsMs: i });
    }
    runtime.flushRisk();
    // Hanya mark TERBARU yang diproses.
    expect(seen).toEqual(["119"]);
    expect(runtime.metricsSnapshot().marksCoalesced).toBe(19);
    await runtime.stop();
  });
});

describe("14 & 15. stream pasar ephemeral", () => {
  test("event pasar tidak pernah masuk domain_events", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h);

    const { provider, runtime } = makeRuntime();
    await runtime.start();
    for (let i = 0; i < 30; i += 1) {
      provider.ticker({ contract: "BTC_USDT", lastPrice: "1", markPrice: String(100 + i), indexPrice: "1", tsMs: i });
      provider.bookTicker({ contract: "BTC_USDT", bid: "1", bidSize: 1, ask: "2", askSize: 1, tsMs: i });
    }
    await runtime.stop();

    // Outbox akun TIDAK terisi oleh data pasar.
    const events = await h.request("GET", `/api/v1/accounts/${accountId}/events`);
    expect(events.json.events.every((event: any) => !String(event.type).startsWith("market."))).toBe(true);
  });

  test("coalescing pasar: keadaan terbaru per (kontrak, jenis) saja", async () => {
    const published: Array<{ type: string; contract: string }> = [];
    const { provider, runtime } = makeRuntime({
      onMarketEvent: (event) => published.push({ type: event.type, contract: event.contract }),
    });
    await runtime.start();
    for (let i = 0; i < 5; i += 1) {
      provider.ticker({ contract: "BTC_USDT", lastPrice: "1", markPrice: String(100 + i), indexPrice: "1", tsMs: i });
    }
    // Runtime menerbitkan setiap perubahan ke hub; coalescing sebenarnya terjadi
    // di hub per koneksi (diuji di phase6-realtime). Di sini kita pastikan
    // runtime TIDAK menulis apa pun ke outbox dan hanya menerbitkan tipe pasar.
    expect(published.every((event) => event.type.startsWith("market."))).toBe(true);
    await runtime.stop();
  });
});

describe("16 & 18. pemroses risiko live", () => {
  test("hanya akun dengan posisi di kontrak itu yang diproses", async () => {
    const db: TempDatabase = openTempDatabase();
    try {
      const accounts = new AccountRepository(db.connection);
      const contracts = new ContractRepository(db.connection);
      contracts.upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
      const withPosition = accounts.create({ name: "a", mode: "simulation", initialBalance: "1000", createdAtMs: 1 });
      const withoutPosition = accounts.create({ name: "b", mode: "simulation", initialBalance: "1000", createdAtMs: 1 });
      const positions = new PositionRepository(db.connection);
      positions.create({
        id: "pos-1",
        accountId: withPosition.id,
        contract: "BTC_USDT",
        direction: "long",
        size: 1,
        entryPrice: new Decimal("80000"),
        leverage: new Decimal("10"),
        initialMargin: new Decimal("0.8"),
        tsMs: 1,
      });

      const processor = new LiveRiskProcessor({
        positions,
        markToMarket: new MarkToMarketService({ connection: db.connection }),
        clock: virtualClock(1000),
      });

      const result = processor.handleMark("BTC_USDT", { markPrice: "80000", eventTsMs: 1000 });
      expect(result.accountsProcessed).toEqual([withPosition.id]);
      expect(result.accountsProcessed).not.toContain(withoutPosition.id);
    } finally {
      db.cleanup();
    }
  });

  test("command id deterministik: mark yang sama tidak menggandakan efek", async () => {
    const db: TempDatabase = openTempDatabase();
    try {
      const accounts = new AccountRepository(db.connection);
      const contracts = new ContractRepository(db.connection);
      contracts.upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
      const account = accounts.create({ name: "a", mode: "simulation", initialBalance: "1000", createdAtMs: 1 });
      const positions = new PositionRepository(db.connection);
      positions.create({
        id: "pos-1",
        accountId: account.id,
        contract: "BTC_USDT",
        direction: "long",
        size: 1,
        entryPrice: new Decimal("80000"),
        leverage: new Decimal("10"),
        initialMargin: new Decimal("0.8"),
        tsMs: 1,
      });
      const processor = new LiveRiskProcessor({
        positions,
        markToMarket: new MarkToMarketService({ connection: db.connection }),
        clock: virtualClock(1000),
      });

      const commandId = LiveRiskProcessor.commandId({
        accountId: account.id,
        contract: "BTC_USDT",
        sourceTimestampMs: 1000,
        markPrice: "70000",
      });
      expect(commandId).toBe(`live-mark:${account.id}:BTC_USDT:1000:70000`);

      // Mark yang sama dua kali: posisi likuidatable, tetapi efeknya sekali.
      processor.handleMark("BTC_USDT", { markPrice: "70000", eventTsMs: 1000 });
      processor.handleMark("BTC_USDT", { markPrice: "70000", eventTsMs: 1000 });
      const closed = db.connection.sqlite
        .query("SELECT COUNT(*) AS n FROM positions WHERE status = 'closed'")
        .get() as { n: number };
      expect(closed.n).toBe(1);
      const pnlEntries = db.connection.sqlite
        .query("SELECT COUNT(*) AS n FROM ledger WHERE type = 'pnl_realized'")
        .get() as { n: number };
      expect(pnlEntries.n).toBe(1);
    } finally {
      db.cleanup();
    }
  });
});

describe("22 & 23. mode dan readiness", () => {
  test("mode live: endpoint simulasi mati secara default", async () => {
    const h = setupApi({ mode: "live" });
    harnesses.push(h);
    const response = await h.request("POST", "/api/v1/simulation/market", {
      contract: "BTC_USDT",
      markPrice: "1",
      bidPrice: "1",
      askPrice: "1",
    });
    expect(response.status).toBe(404);
    expect(h.context.mode).toBe("live");
    expect(h.context.simulationEnabled).toBe(false);
  });

  test("mode simulation: endpoint simulasi hidup", async () => {
    const h = setupApi({ mode: "simulation" });
    harnesses.push(h);
    expect(h.context.simulationEnabled).toBe(true);
  });

  test("readiness live mengikuti kesehatan feed", async () => {
    let feedReady = false;
    const h = setupApi({
      mode: "live",
      feedHealth: () => ({ state: feedReady ? "open" : "reconnecting", ready: feedReady }),
    });
    harnesses.push(h);

    const notReady = await h.request("GET", "/health/ready");
    expect(notReady.status).toBe(503);
    expect(notReady.json.checks.marketFeed).toBe(false);

    feedReady = true;
    const ready = await h.request("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.json.checks.marketFeed).toBe(true);
  });

  test("GET /market/health mengembalikan status feed", async () => {
    const h = setupApi({
      mode: "live",
      feedHealth: () => ({ state: "open", ready: true, staleContracts: ["BTC_USDT"], unsyncedBooks: [] }),
    });
    harnesses.push(h);
    const response = await h.request("GET", "/api/v1/market/health");
    expect(response.status).toBe(200);
    expect(response.json.mode).toBe("live");
    expect(response.json.feed.state).toBe("open");
  });
});

describe("24. shutdown bersih", () => {
  test("stop menghentikan timer dan koneksi", async () => {
    const { provider, runtime } = makeRuntime();
    await runtime.start();
    await runtime.stop();
    expect(provider.state()).toBe("closed");
    // flushRisk setelah stop tidak memproses apa pun.
    runtime.flushRisk();
    expect(runtime.metricsSnapshot().riskEvaluations).toBe(0);
  });
});

describe("Phase 7A: read model pasar", () => {
  test("GET /market/state menyajikan mark dari provider, sisanya null (tidak dikarang)", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80445.79");
    const response = await h.request("GET", "/api/v1/market/state?contracts=BTC_USDT");
    expect(response.status).toBe(200);
    expect(response.json.mode).toBe("simulation");
    const entry = response.json.contracts[0];
    expect(entry.contract).toBe("BTC_USDT");
    expect(entry.markPrice).toBe("80445.79");
    expect(entry.bestBid).toBe("80445.79");
    expect(entry.bestAsk).toBe("80445.79");
    // Tanpa runtime pasar, last/index tidak tersedia → null, bukan ditebak.
    expect(entry.lastPrice).toBeNull();
    expect(entry.indexPrice).toBeNull();
  });

  test("GET /market/state memakai runtime pasar bila tersedia", async () => {
    const h = setupApi({
      marketDetail: (contract) => ({
        contract,
        markPrice: "100",
        markSourceTimestampMs: 1,
        markStatus: "fresh",
        lastPrice: "99",
        indexPrice: "101",
        fundingRate: "0.0001",
        fundingNextApplyMs: 2,
        bestBid: "99.5",
        bestBidSize: 10,
        bestAsk: "100.5",
        bestAskSize: 20,
        depthStatus: "synced",
      }),
    });
    harnesses.push(h);
    const response = await h.request("GET", "/api/v1/market/state?contracts=BTC_USDT");
    const entry = response.json.contracts[0];
    expect(entry.markPrice).toBe("100");
    expect(entry.lastPrice).toBe("99");
    expect(entry.indexPrice).toBe("101");
    expect(entry.depthStatus).toBe("synced");
  });

  test("GET /market/state menolak daftar kosong", async () => {
    const h = setupApi();
    harnesses.push(h);
    const response = await h.request("GET", "/api/v1/market/state?contracts=%20");
    expect(response.status).toBe(400);
  });

  test("GET /market/candles mengembalikan candle tersimpan urut naik", async () => {
    const h = setupApi();
    harnesses.push(h);
    const { CandleRepository } = await import("../apps/server/src/repositories/candle-repository.js");
    const repo = new CandleRepository(h.connection);
    for (const t of [300, 600, 900]) {
      repo.upsert({
        candle: { contract: "BTC_USDT", interval: "5m", openTimeSeconds: t, o: "1", h: "2", l: "0.5", c: "1.5", v: 10, sum: "15", windowClosed: true },
        provider: "gateio",
        ingestedAtMs: t,
      });
    }
    const response = await h.request("GET", "/api/v1/market/candles?contract=BTC_USDT&interval=5m&limit=2");
    expect(response.status).toBe(200);
    expect(response.json.candles).toHaveLength(2);
    expect(response.json.candles.map((candle: any) => candle.openTime)).toEqual([600, 900]);
    // Nilai finansial tetap string.
    expect(typeof response.json.candles[0].close).toBe("string");
  });

  test("GET /market/candles untuk kontrak tanpa data → daftar kosong", async () => {
    const h = setupApi();
    harnesses.push(h);
    const response = await h.request("GET", "/api/v1/market/candles?contract=NOPE_USDT");
    expect(response.status).toBe(200);
    expect(response.json.candles).toEqual([]);
  });
});
