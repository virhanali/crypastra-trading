import { afterEach, describe, expect, test } from "bun:test";
import { Decimal, observationToEvents, observationsFromEvent, shouldRecordObservation, virtualClock, type MarketObservation } from "../packages/core/src/index.js";
import { MarketRecorder } from "../apps/server/src/market/market-recorder.js";
import { MarketObservationRepository, RecordingSessionRepository } from "../apps/server/src/repositories/market-observation-repository.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";
import { BTC_USDT } from "./helpers/fixtures.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { AccountRepository } from "../apps/server/src/repositories/account-repository.js";

const dbs: TempDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.cleanup();
});

function setup() {
  const db = openTempDatabase();
  dbs.push(db);
  const contracts = new ContractRepository(db.connection);
  contracts.upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
  const sessions = new RecordingSessionRepository(db.connection);
  const observations = new MarketObservationRepository(db.connection);
  const recorder = new MarketRecorder({ sessions, observations });
  return { db, sessions, observations, recorder };
}

/** Event ticker nyata (bentuk yang diproduksi adapter Gate). */
function tickerEvent(input: { mark: string; last?: string; index?: string; funding?: string | null; nextApply?: number | null; tsMs: number }) {
  return {
    type: "ticker" as const,
    ticker: {
      contract: "BTC_USDT",
      lastPrice: input.last ?? input.mark,
      markPrice: input.mark,
      indexPrice: input.index ?? input.mark,
      fundingRate: input.funding ?? null,
      fundingRateIndicative: input.funding ?? null,
      fundingNextApplySeconds: input.nextApply ?? null,
      fundingIntervalSeconds: input.nextApply === null || input.nextApply === undefined ? null : 28800,
      eventTsMs: input.tsMs,
    },
  };
}

function quoteEvent(bid: string, ask: string, tsMs: number) {
  return {
    type: "book_ticker" as const,
    bookTicker: {
      contract: "BTC_USDT",
      bestBid: bid,
      bestBidSize: 100,
      bestAsk: ask,
      bestAskSize: 200,
      updateId: tsMs,
      eventTsMs: tsMs,
    },
  };
}

describe("1 & 5. siklus hidup sesi perekaman", () => {
  test("start → stop → inspect", () => {
    const { sessions, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 1000 });
    expect(recorder.isRecording()).toBe(true);
    const session = sessions.require(id);
    expect(session.status).toBe("recording");
    expect(session.contracts).toEqual(["BTC_USDT"]);
    expect(session.endedAtMs).toBeNull();

    recorder.stopSession(5000);
    const stopped = sessions.require(id);
    expect(stopped.status).toBe("completed");
    expect(stopped.endedAtMs).toBe(5000);
    expect(recorder.isRecording()).toBe(false);
  });

  test("stop idempoten", () => {
    const { sessions, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 1000 });
    recorder.stopSession(5000);
    recorder.stopSession(9000);
    expect(sessions.require(id).endedAtMs).toBe(5000);
  });

  test("sesi tanpa kontrak ditolak", () => {
    const { recorder } = setup();
    expect(() => recorder.startSession({ source: "live", contracts: [], startedAtMs: 1 })).toThrow();
  });
});

describe("7. kebijakan perekaman", () => {
  test("tanpa sesi aktif TIDAK ada yang ditulis (perilaku Phase 6 tidak berubah)", () => {
    const { observations, recorder } = setup();
    recorder.onEvent(tickerEvent({ mark: "80000", tsMs: 1000 }), 1000);
    recorder.onEvent(quoteEvent("79999", "80001", 1000), 1000);
    expect(observations.count("tidak-ada-sesi")).toBe(0);
    expect(recorder.metrics().observationsWritten).toBe(0);
  });

  test("mark SELALU ditulis (agar staleness replay identik dengan live)", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    recorder.onEvent(tickerEvent({ mark: "80000", tsMs: 1000 }), 1000);
    // Nilai mark sama, waktu berbeda: BUKAN duplikat — tetap ditulis.
    recorder.onEvent(tickerEvent({ mark: "80000", tsMs: 2000 }), 2000);
    recorder.onEvent(tickerEvent({ mark: "80000", tsMs: 3000 }), 3000);
    expect(observations.count(id)).toBe(3);
  });

  test("quote hanya ditulis saat nilai berubah", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    recorder.onEvent(quoteEvent("79999", "80001", 1), 1);
    recorder.onEvent(quoteEvent("79999", "80001", 2), 2); // identik → dilewati
    recorder.onEvent(quoteEvent("79998", "80001", 3), 3); // bid berubah → ditulis
    const rows = observations.list(id, { kind: "quote" });
    expect(rows).toHaveLength(2);
    expect(recorder.metrics().observationsSkippedUnchanged).toBeGreaterThanOrEqual(1);
  });

  test("funding hanya ditulis saat rate/jadwal berubah", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    recorder.onEvent(tickerEvent({ mark: "80000", funding: "0.0001", nextApply: 1789920000, tsMs: 1 }), 1);
    recorder.onEvent(tickerEvent({ mark: "80000", funding: "0.0001", nextApply: 1789920000, tsMs: 2 }), 2);
    recorder.onEvent(tickerEvent({ mark: "80000", funding: "0.0002", nextApply: 1789920000, tsMs: 3 }), 3);
    expect(observations.list(id, { kind: "funding" })).toHaveLength(2);
  });

  test("hanya candle TERTUTUP yang direkam", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    const candle = (closed: boolean, t: number) => ({
      type: "candle" as const,
      candle: { contract: "BTC_USDT", interval: "5m", openTimeSeconds: t, o: "1", h: "2", l: "0.5", c: "1.5", v: 10, sum: "0", windowClosed: closed },
    });
    recorder.onEvent(candle(false, 300), 1);
    expect(observations.list(id, { kind: "candle" })).toHaveLength(0);
    recorder.onEvent(candle(true, 300), 2);
    expect(observations.list(id, { kind: "candle" })).toHaveLength(1);
  });

  test("tidak ada observasi kedalaman (depth) yang direkam", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    recorder.onEvent(
      { type: "book_update", update: { contract: "BTC_USDT", firstUpdateId: 1, lastUpdateId: 2, eventTsMs: 1, bids: [{ price: "1", size: 1 }], asks: [] } },
      1,
    );
    expect(observations.count(id)).toBe(0);
  });
});

describe("8. dedupe", () => {
  test("observasi identik pada identitas sumber sama tidak menggandakan", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    const mark: MarketObservation = {
      kind: "mark",
      contract: "BTC_USDT",
      sourceTimestampMs: 1000,
      observedAtMs: 1000,
      markPrice: "80000",
      lastPrice: "80000",
      indexPrice: "80000",
    };
    expect(recorder.record(id, mark, 1000)).toBe(true);
    // Pesan ulang setelah reconnect dengan identitas sumber sama → duplikat.
    expect(recorder.record(id, mark, 1500)).toBe(false);
    expect(observations.count(id)).toBe(1);
    expect(recorder.metrics().observationsDeduplicated).toBe(1);
  });

  test("nilai sama pada waktu sumber BERBEDA tetap tersimpan", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    const mark = (ts: number): MarketObservation => ({
      kind: "mark", contract: "BTC_USDT", sourceTimestampMs: ts, observedAtMs: ts,
      markPrice: "80000", lastPrice: "80000", indexPrice: "80000",
    });
    recorder.record(id, mark(1000), 1000);
    recorder.record(id, mark(2000), 2000);
    expect(observations.count(id)).toBe(2);
  });
});

describe("4 & 9. penyimpanan & urutan", () => {
  test("nilai finansial disimpan sebagai string, bukan number", () => {
    const { db, observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    recorder.onEvent(tickerEvent({ mark: "80445.79", last: "80444", index: "80481.38", tsMs: 1000 }), 1000);
    const raw = db.connection.sqlite
      .query("SELECT data_json FROM market_observations WHERE session_id = ?")
      .get(id) as { data_json: string };
    expect(raw.data_json).toContain('"markPrice":"80445.79"');
    expect(raw.data_json).not.toMatch(/"markPrice":\s*[0-9]/);
  });

  test("urutan replay = seq ASC, bukan timestamp", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    // Sengaja disimpan dengan timestamp sumber tidak monoton.
    recorder.record(id, { kind: "mark", contract: "BTC_USDT", sourceTimestampMs: 5000, observedAtMs: 5000, markPrice: "1", lastPrice: null, indexPrice: null }, 1);
    recorder.record(id, { kind: "mark", contract: "BTC_USDT", sourceTimestampMs: 1000, observedAtMs: 1000, markPrice: "2", lastPrice: null, indexPrice: null }, 2);
    const rows = observations.list(id);
    expect(rows.map((row) => (row.observation as { markPrice: string }).markPrice)).toEqual(["1", "2"]);
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
  });

  test("market_observations append-only di level database", () => {
    const { db, observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    recorder.onEvent(tickerEvent({ mark: "1", tsMs: 1 }), 1);
    expect(() => db.connection.sqlite.prepare("UPDATE market_observations SET kind = 'x'").run()).toThrow(/append-only/);
    expect(() => db.connection.sqlite.prepare("DELETE FROM market_observations").run()).toThrow(/append-only/);
    void observations;
  });

  test("filter kontrak, jenis, rentang waktu, dan paginasi", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    recorder.record(id, { kind: "mark", contract: "BTC_USDT", sourceTimestampMs: 1000, observedAtMs: 1000, markPrice: "1", lastPrice: null, indexPrice: null }, 1);
    recorder.record(id, { kind: "mark", contract: "BTC_USDT", sourceTimestampMs: 2000, observedAtMs: 2000, markPrice: "2", lastPrice: null, indexPrice: null }, 2);
    recorder.record(id, { kind: "mark", contract: "ETH_USDT", sourceTimestampMs: 1500, observedAtMs: 1500, markPrice: "3", lastPrice: null, indexPrice: null }, 3);

    expect(observations.list(id, { contract: "ETH_USDT" })).toHaveLength(1);
    expect(observations.list(id, { kind: "mark" })).toHaveLength(3);
    expect(observations.list(id, { fromSourceTsMs: 1500 })).toHaveLength(2);
    expect(observations.list(id, { toSourceTsMs: 1500 })).toHaveLength(2);
    const first = observations.list(id, { limit: 1 });
    expect(observations.list(id, { afterSeq: first[0]!.seq })).toHaveLength(2);
  });
});

describe("2 & 3. model observasi & pemetaan ke event", () => {
  test("observasi mark → event ticker dengan mark/last/index terpisah", () => {
    const events = observationToEvents({
      kind: "mark", contract: "BTC_USDT", sourceTimestampMs: 1, observedAtMs: 1,
      markPrice: "80445.79", lastPrice: "80444", indexPrice: "80481.38",
    });
    expect(events).toHaveLength(1);
    const ticker = (events[0] as { ticker: { markPrice: string; lastPrice: string; indexPrice: string } }).ticker;
    expect(ticker.markPrice).toBe("80445.79");
    expect(ticker.lastPrice).toBe("80444");
    expect(ticker.indexPrice).toBe("80481.38");
  });

  test("observasi funding → ticker yang membawa rate DAN mark", () => {
    const events = observationToEvents({
      kind: "funding", contract: "BTC_USDT", sourceTimestampMs: 1, observedAtMs: 1,
      fundingRate: "0.0001", fundingTimestampMs: 1789920000000, intervalSeconds: 28800, markPrice: "80000",
    });
    const ticker = (events[0] as { ticker: { fundingRate: string | null; markPrice: string } }).ticker;
    expect(ticker.fundingRate).toBe("0.0001");
    expect(ticker.markPrice).toBe("80000");
  });

  test("round-trip event → observasi → event menjaga nilai", () => {
    const original = tickerEvent({ mark: "80445.79", last: "80444", index: "80481.38", tsMs: 1234 });
    const observations = observationsFromEvent(original);
    const mark = observations.find((entry) => entry.kind === "mark")!;
    const back = observationToEvents(mark)[0] as { ticker: { markPrice: string; lastPrice: string } };
    expect(back.ticker.markPrice).toBe("80445.79");
    expect(back.ticker.lastPrice).toBe("80444");
  });

  test("ticker tanpa mark tidak menghasilkan observasi mark", () => {
    const observations = observationsFromEvent({
      type: "ticker",
      ticker: {
        contract: "BTC_USDT", lastPrice: "1", markPrice: "", indexPrice: "", fundingRate: null,
        fundingRateIndicative: null, fundingNextApplySeconds: null, fundingIntervalSeconds: null, eventTsMs: 1,
      },
    });
    expect(observations.filter((entry) => entry.kind === "mark")).toHaveLength(0);
  });

  test("shouldRecordObservation: mark selalu, quote hanya saat berubah", () => {
    const markA: MarketObservation = { kind: "mark", contract: "B", sourceTimestampMs: 1, observedAtMs: 1, markPrice: "1", lastPrice: null, indexPrice: null };
    expect(shouldRecordObservation(markA, markA)).toBe(true);
    const quoteA: MarketObservation = { kind: "quote", contract: "B", sourceTimestampMs: 1, observedAtMs: 1, bestBid: "1", bestBidSize: 1, bestAsk: "2", bestAskSize: 1 };
    expect(shouldRecordObservation(quoteA, quoteA)).toBe(false);
    expect(shouldRecordObservation({ ...quoteA, bestAsk: "3" }, quoteA)).toBe(true);
  });
});

describe("10. VirtualClock", () => {
  test("clock virtual tidak pernah mundur dan dapat di-set maju", () => {
    const clock = virtualClock(1000);
    expect(clock.nowMs()).toBe(1000);
    clock.advance(500);
    expect(clock.nowMs()).toBe(1500);
    clock.set(9000);
    expect(clock.nowMs()).toBe(9000);
    expect(() => clock.set(100)).toThrow();
    expect(() => clock.advance(-1)).toThrow();
  });
});

describe("27. statistik & estimasi penyimpanan", () => {
  test("menghitung jumlah per jenis/kontrak dan proyeksi ukuran", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    for (let i = 0; i < 10; i += 1) {
      recorder.onEvent(tickerEvent({ mark: String(80000 + i), funding: "0.0001", nextApply: 1789920000, tsMs: (i + 1) * 1000 }), (i + 1) * 1000);
      recorder.onEvent(quoteEvent("79999", String(80001 + i), (i + 1) * 1000), (i + 1) * 1000);
    }
    recorder.stopSession(10_000);
    const stats = observations.stats(id);
    expect(stats.total).toBeGreaterThan(10);
    expect(stats.byKind.mark).toBe(10);
    expect(stats.byContract.BTC_USDT).toBe(stats.total);
    expect(stats.durationMs).toBe(10_000);
    expect(stats.observationsPerSecond).toBeGreaterThan(0);
    expect(stats.projectedBytes.twentyFourHours).toBeGreaterThan(stats.projectedBytes.oneHour);
  });

  test("nilai finansial tetap string saat dibaca kembali", () => {
    const { observations, recorder } = setup();
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0 });
    recorder.onEvent(tickerEvent({ mark: "80445.79", tsMs: 1 }), 1);
    const [row] = observations.list(id);
    const mark = row!.observation as { markPrice: string };
    expect(typeof mark.markPrice).toBe("string");
    expect(new Decimal(mark.markPrice).eq(new Decimal("80445.79"))).toBe(true);
  });

  test("rekam → baca ulang konsisten (account/session terpisah)", () => {
    const { db, observations, recorder, sessions } = setup();
    const accounts = new AccountRepository(db.connection);
    const account = accounts.create({ name: "rec", mode: "simulation", initialBalance: "0", createdAtMs: 1 });
    const id = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 0, metadata: { accountId: account.id } });
    recorder.onEvent(tickerEvent({ mark: "1", tsMs: 1 }), 1);
    recorder.stopSession(2);
    expect(sessions.require(id).metadata.accountId).toBe(account.id);
    expect(observations.list(id)).toHaveLength(1);
  });
});
