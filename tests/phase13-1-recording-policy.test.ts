import { afterEach, describe, expect, test } from "bun:test";
import {
  analyzeCandleGaps,
  compactSecondBucket,
  FULL_RECORDING_POLICY,
  recordingPolicyFromEnv,
  RESEARCH_COMPACT_POLICY_V1,
  type MarketObservation,
} from "../packages/core/src/index.js";
import { MarketRecorder } from "../apps/server/src/market/market-recorder.js";
import { MarketObservationRepository, RecordingSessionRepository } from "../apps/server/src/repositories/market-observation-repository.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";

const dbs: TempDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.cleanup();
});

function setup(policy?: Parameters<typeof recorderFactory>[0]) {
  return recorderFactory(policy);
}

function recorderFactory(policy?: { name: "full" | "research-compact" }) {
  const db = openTempDatabase();
  dbs.push(db);
  const sessions = new RecordingSessionRepository(db.connection);
  const observations = new MarketObservationRepository(db.connection);
  const resolved =
    policy?.name === "research-compact" ? RESEARCH_COMPACT_POLICY_V1 : FULL_RECORDING_POLICY;
  const recorder = new MarketRecorder({ sessions, observations, policy: resolved });
  const sessionId = recorder.startSession({
    source: "live",
    contracts: ["BTC_USDT"],
    startedAtMs: 1_000,
    metadata: { recordingPolicy: resolved.name, recordingPolicyVersion: resolved.version },
  });
  return { db, sessions, observations, recorder, sessionId };
}

function mark(contract: string, price: string, tsMs: number): MarketObservation {
  return {
    kind: "mark",
    contract,
    markPrice: price,
    lastPrice: price,
    indexPrice: price,
    sourceTimestampMs: tsMs,
    observedAtMs: tsMs,
  };
}

function quote(contract: string, bid: string, ask: string, tsMs: number): MarketObservation {
  return {
    kind: "quote",
    contract,
    bestBid: bid,
    bestBidSize: 1,
    bestAsk: ask,
    bestAskSize: 1,
    sourceTimestampMs: tsMs,
    observedAtMs: tsMs,
  };
}

function funding(contract: string, rate: string, tsMs: number): MarketObservation {
  return {
    kind: "funding",
    contract,
    fundingRate: rate,
    fundingTimestampMs: tsMs,
    intervalSeconds: 28800,
    markPrice: "80000",
    sourceTimestampMs: tsMs,
    observedAtMs: tsMs,
  };
}

function candle(contract: string, openTimeSeconds: number, close: string): MarketObservation {
  return {
    kind: "candle",
    contract,
    interval: "5m",
    openTimeSeconds,
    open: "80000",
    high: "81000",
    low: "79000",
    close,
    volume: 10,
    closed: true,
    sourceTimestampMs: openTimeSeconds * 1000 + 300_000,
    observedAtMs: openTimeSeconds * 1000 + 300_000,
  };
}

function candlesFrom(baseOpenTime: number, count: number, contract = "BTC_USDT"): number[] {
  return Array.from({ length: count }, (_, i) => baseOpenTime + i * 300);
}

describe("kebijakan dari env", () => {
  test("default FULL bila env kosong", () => {
    expect(recordingPolicyFromEnv({}).name).toBe("full");
  });
  test("research-compact dikenali (beberapa ejaan)", () => {
    expect(recordingPolicyFromEnv({ CRYPASTRA_RECORDING_POLICY: "research-compact" }).name).toBe(
      "research-compact",
    );
    expect(recordingPolicyFromEnv({ CRYPASTRA_RECORDING_POLICY: "compact" }).name).toBe(
      "research-compact",
    );
  });
  test("nilai tak dikenal jatuh ke FULL (fail aman, bukan drop data)", () => {
    expect(recordingPolicyFromEnv({ CRYPASTRA_RECORDING_POLICY: "ultra-hd" }).name).toBe("full");
  });
  test("bucket detik = floor(ts/1000)", () => {
    expect(compactSecondBucket(1_700_000_000_012)).toBe(1_700_000_000);
    expect(compactSecondBucket(1_700_000_000_999)).toBe(1_700_000_000);
    expect(compactSecondBucket(1_700_000_001_000)).toBe(1_700_000_001);
  });
});

describe("FULL tidak berubah (kompatibilitas mundur)", () => {
  test("default recorder = FULL", () => {
    const { recorder } = setup();
    expect(recorder.policy().name).toBe("full");
  });
  test("badai quote dalam 1 detik SEMUA terekam (tanpa coalescing)", () => {
    const { observations, recorder, sessionId } = setup();
    for (let i = 0; i < 5; i++) {
      recorder.record(sessionId, quote("BTC_USDT", `7999${i}`, `8000${i}`, 5_000 + i * 10), 5_000 + i * 10);
    }
    expect(observations.count(sessionId)).toBe(5);
    expect(recorder.metrics().observationsCoalesced).toBe(0);
  });
  test("mark selalu terekam", () => {
    const { observations, recorder, sessionId } = setup();
    recorder.record(sessionId, mark("BTC_USDT", "80000", 5_000), 5_000);
    recorder.record(sessionId, mark("BTC_USDT", "80001", 5_100), 5_100);
    expect(observations.count(sessionId)).toBe(2);
  });
});

describe("RESEARCH_COMPACT coalescing", () => {
  test("quote: 5 perubahan/detik -> 1 terekam, 4 coalesced", () => {
    const { observations, recorder, sessionId } = setup({ name: "research-compact" });
    for (let i = 0; i < 5; i++) {
      recorder.record(sessionId, quote("BTC_USDT", `7999${i}`, `8000${i}`, 5_000 + i * 10), 5_000 + i * 10);
    }
    expect(observations.count(sessionId)).toBe(1);
    expect(recorder.metrics().observationsCoalesced).toBe(4);
  });
  test("quote: detik berikutnya lolos lagi; kontrak lain bucket sendiri", () => {
    const { observations, recorder, sessionId } = setup({ name: "research-compact" });
    recorder.record(sessionId, quote("BTC_USDT", "79990", "80000", 5_000), 5_000);
    recorder.record(sessionId, quote("BTC_USDT", "79991", "80001", 5_900), 5_900);
    recorder.record(sessionId, quote("BTC_USDT", "79992", "80002", 6_000), 6_000);
    recorder.record(sessionId, quote("ETH_USDT", "3999", "4000", 5_500), 5_500);
    expect(observations.count(sessionId)).toBe(3);
  });
  test("mark: 1/detik (yang pertama menang, tanpa nilai karangan)", () => {
    const { observations, recorder, sessionId } = setup({ name: "research-compact" });
    recorder.record(sessionId, mark("BTC_USDT", "80000", 5_000), 5_000);
    recorder.record(sessionId, mark("BTC_USDT", "80001", 5_500), 5_500);
    const rows = observations.list(sessionId, {});
    expect(rows).toHaveLength(1);
    expect((rows[0]!.observation as { markPrice: string }).markPrice).toBe("80000");
  });
  test("candle TIDAK PERNAH dibuang compact", () => {
    const { observations, recorder, sessionId } = setup({ name: "research-compact" });
    recorder.record(sessionId, candle("BTC_USDT", 1_000_000, "80000"), 1_000_300_000);
    recorder.record(sessionId, candle("BTC_USDT", 1_000_300, "80010"), 1_000_600_000);
    expect(observations.count(sessionId)).toBe(2);
    expect(recorder.metrics().observationsCoalesced).toBe(0);
  });
  test("funding yang berubah TIDAK PERNAH dibuang compact; yang sama tetap skip", () => {
    const { observations, recorder, sessionId } = setup({ name: "research-compact" });
    recorder.record(sessionId, funding("BTC_USDT", "0.0001", 5_000), 5_000);
    recorder.record(sessionId, funding("BTC_USDT", "0.0002", 5_500), 5_500);
    // Event funding SAMA (rate + timestamp sama) yang teramati belakangan: skip, bukan coalesced.
    const same = funding("BTC_USDT", "0.0002", 5_500);
    recorder.record(sessionId, { ...same, observedAtMs: 6_000 }, 6_000);
    expect(observations.count(sessionId)).toBe(2);
    expect(recorder.metrics().observationsCoalesced).toBe(0);
    expect(recorder.metrics().observationsSkippedUnchanged).toBe(1);
  });
  test("deterministik: urutan input sama -> keputusan sama", () => {
    const first = setup({ name: "research-compact" });
    const second = setup({ name: "research-compact" });
    const inputs: MarketObservation[] = [
      quote("BTC_USDT", "79990", "80000", 5_000),
      quote("BTC_USDT", "79991", "80001", 5_050),
      mark("BTC_USDT", "80000", 5_100),
      quote("BTC_USDT", "79992", "80002", 6_000),
    ];
    const run = (r: typeof first) => inputs.map((o) => r.recorder.record(r.sessionId, o, o.sourceTimestampMs));
    expect(run(first)).toEqual(run(second));
    expect(first.recorder.metrics()).toEqual(second.recorder.metrics());
  });
});

describe("gap-aware readiness (EMA200 jujur)", () => {
  const base = 1_700_000_000;
  test("kosong -> NOT_READY", () => {
    const analysis = analyzeCandleGaps([], 300);
    expect(analysis.closedCandles).toBe(0);
    expect(analysis.consecutiveTrailing).toBe(0);
    expect(analysis.ema200Ready).toBe(false);
  });
  test("199 berurutan -> NOT_READY", () => {
    const analysis = analyzeCandleGaps(candlesFrom(base, 199), 300);
    expect(analysis.consecutiveTrailing).toBe(199);
    expect(analysis.gapCount).toBe(0);
    expect(analysis.ema200Ready).toBe(false);
  });
  test("200 berurutan -> READY", () => {
    const analysis = analyzeCandleGaps(candlesFrom(base, 200), 300);
    expect(analysis.consecutiveTrailing).toBe(200);
    expect(analysis.ema200Ready).toBe(true);
  });
  test("200 total dengan 1 celah -> NOT_READY + statistik celah benar", () => {
    const first = candlesFrom(base, 100);
    const second = candlesFrom(base + 101 * 300, 100);
    const analysis = analyzeCandleGaps([...first, ...second], 300);
    expect(analysis.closedCandles).toBe(200);
    expect(analysis.gapCount).toBe(1);
    expect(analysis.largestGapCandles).toBe(1);
    expect(analysis.lastGapAtSeconds).toBe(base + 99 * 300);
    expect(analysis.consecutiveTrailing).toBe(100);
    expect(analysis.ema200Ready).toBe(false);
  });
  test("duplikat + acak didedupe/disortir; celah terbesar dilaporkan", () => {
    const ordered = candlesFrom(base, 10);
    const shuffled = [...ordered].reverse();
    shuffled.push(ordered[3]!);
    // Hapus 2 candle (indeks 5,6) -> celah 2 candle.
    const withHole = shuffled.filter((t) => t !== base + 5 * 300 && t !== base + 6 * 300);
    const analysis = analyzeCandleGaps(withHole, 300);
    expect(analysis.closedCandles).toBe(8);
    expect(analysis.gapCount).toBe(1);
    expect(analysis.largestGapCandles).toBe(2);
    expect(analysis.consecutiveTrailing).toBe(3);
    expect(analysis.ema200Ready).toBe(false);
  });
});

describe("status murah: query basic memakai indeks (tanpa SCAN payload)", () => {
  test("EXPLAIN QUERY PLAN basic queries: tanpa SCAN market_observations", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const sessionRepo = new RecordingSessionRepository(db.connection);
    const sessionId = sessionRepo.start({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 1 });
    const queries = [
      "SELECT contract, kind, count(*) as n FROM market_observations WHERE session_id = ? GROUP BY contract, kind",
      "SELECT contract, data_json as dataJson FROM market_observations WHERE session_id = ? AND kind = 'candle'",
      "SELECT observed_at_ms as lastMs FROM market_observations WHERE session_id = ? ORDER BY observed_at_ms DESC LIMIT 1",
      "SELECT avg(length(data_json)) as avg FROM (SELECT data_json FROM market_observations WHERE session_id = ? LIMIT 500)",
    ];
    for (const sql of queries) {
      const plan = db.connection.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(sessionId) as Array<{
        detail: string;
      }>;
      const text = plan.map((row) => row.detail).join(" | ");
      // Boleh: "SCAN ... USING [COVERING] INDEX" (index-only) dan
      // "SCAN (subquery-N)" (materialisasi subquery ber-LIMIT kecil).
      // Tidak boleh: SCAN telanjang tabel market_observations (full scan
      // payload jutaan baris).
      const bareTableScan = plan.some(
        (row) => row.detail.startsWith("SCAN market_observations") && !row.detail.includes("USING"),
      );
      expect(bareTableScan).toBe(false);
    }
  });
});
