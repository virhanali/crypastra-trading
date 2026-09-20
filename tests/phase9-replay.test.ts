import { afterEach, describe, expect, test } from "bun:test";
import { computeFeaturesBatch, virtualClock, type MarketObservation } from "../packages/core/src/index.js";
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import { MarketRecorder } from "../apps/server/src/market/market-recorder.js";
import {
  MarketObservationRepository,
  RecordingSessionRepository,
} from "../apps/server/src/repositories/market-observation-repository.js";
import { ReplayService } from "../apps/server/src/services/replay-service.js";
import { AccountRepository } from "../apps/server/src/repositories/account-repository.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { LedgerRepository } from "../apps/server/src/repositories/ledger-repository.js";
import { bullishSetupCandles } from "./helpers/candles.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";
import { BTC_USDT } from "./helpers/fixtures.js";

const dbs: TempDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.cleanup();
});

const T0 = 1_700_000_000_000;

/**
 * Rekaman berisi 259 candle 5m TERTUTUP dari fixture setup bullish.
 *
 * Sengaja bukan sesi smoke 20 detik: warmup EMA200 menuntut >= 200 candle, dan
 * syarat itu TIDAK dilonggarkan hanya supaya sesi pendek menghasilkan sinyal.
 */
function recordSession(): { sessionId: string; accountId: string; db: TempDatabase } {
  const db = openTempDatabase();
  dbs.push(db);
  new ContractRepository(db.connection).upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
  const account = new AccountRepository(db.connection).create({
    name: "replay-analytics",
    mode: "simulation",
    initialBalance: "1000",
    createdAtMs: 1,
  });
  new LedgerRepository(db.connection).append({
    accountId: account.id,
    tsMs: 1,
    type: "deposit",
    amount: "0",
    idempotencyKey: `${account.id}:seed`,
  });

  const recorder = new MarketRecorder({
    sessions: new RecordingSessionRepository(db.connection, () => "sess-analytics"),
    observations: new MarketObservationRepository(db.connection),
  });
  const sessionId = recorder.startSession({
    source: "live",
    contracts: ["BTC_USDT"],
    startedAtMs: T0,
  });

  for (const candle of bullishSetupCandles("BTC_USDT")) {
    const observedAtMs = T0 + candle.openTimeSeconds * 1000;
    const observation: MarketObservation = {
      kind: "candle",
      contract: "BTC_USDT",
      sourceTimestampMs: observedAtMs,
      observedAtMs,
      interval: candle.interval,
      openTimeSeconds: candle.openTimeSeconds,
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
      volume: candle.v,
      closed: true,
    };
    recorder.record(sessionId, observation, observedAtMs);
  }
  recorder.stopSession(T0 + 100 * 24 * 3600_000);
  return { sessionId, accountId: account.id, db };
}

function runReplay(
  input: { sessionId: string; accountId: string; db: TempDatabase },
  withAnalytics: boolean,
) {
  const clock = virtualClock(T0);
  const analytics = withAnalytics
    ? new AnalyticsService({ connection: input.db.connection, clock, persist: true })
    : undefined;
  const service = new ReplayService({
    target: input.db.connection,
    ...(analytics === undefined ? {} : { analytics }),
  });
  const result = service.run({ sessionId: input.sessionId, accountId: input.accountId });
  return { result, analytics };
}

describe("Phase 9 — integrasi replay", () => {
  test("jalur fitur/scanner yang sama berjalan pada replay", () => {
    const input = recordSession();
    const { result, analytics } = runReplay(input, true);

    const counters = analytics!.counters();
    expect(counters.candlesProcessed).toBe(259);
    expect(counters.featureSnapshotsProduced).toBe(259);
    expect(counters.warmupSkips).toBe(199);
    expect(counters.longSignals + counters.shortSignals + counters.neutralSignals).toBe(60);
    expect(analytics!.persistedScannerCount()).toBe(60);

    expect(result.analytics).toBeDefined();
    expect(result.analytics!.digest.combinedHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("dua replay menghasilkan FeatureSnapshot/Scanner/Signal yang identik", () => {
    const first = runReplay(recordSession(), true);
    const second = runReplay(recordSession(), true);
    expect(first.result.analytics!.digest.combinedHash).toBe(
      second.result.analytics!.digest.combinedHash,
    );
    expect(first.result.analytics!.digest.reasonCodeCounts).toEqual(
      second.result.analytics!.digest.reasonCodeCounts,
    );
    expect(first.analytics!.counters()).toEqual(second.analytics!.counters());
  });

  test("analytics tidak mengubah satu pun hash ekonomi", () => {
    const withA = runReplay(recordSession(), true);
    const withoutA = runReplay(recordSession(), false);
    expect(withA.result.hashes).toEqual(withoutA.result.hashes);
    expect(withA.result.balances).toEqual(withoutA.result.balances);
    expect(withoutA.result.analytics).toBeUndefined();
  });

  test("look-ahead: snapshot pada T identik dengan batch 0..T (tanpa candle masa depan)", () => {
    const input = recordSession();
    const { analytics } = runReplay(input, true);
    const snapshotAtT = analytics!.snapshots()[210]!;

    const allCandles = bullishSetupCandles("BTC_USDT");
    const atT = allCandles.slice(0, 211);
    const batchAtT = computeFeaturesBatch("BTC_USDT", atT)!;
    const batchWithFuture = computeFeaturesBatch("BTC_USDT", allCandles)!;

    // Snapshot di T harus sama dengan batch yang hanya melihat 0..T.
    expect(snapshotAtT).toEqual(batchAtT);
    // Dan TIDAK sama dengan batch yang melihat candle masa depan.
    expect(batchWithFuture.close).not.toBe(batchAtT.close);
  });
});
