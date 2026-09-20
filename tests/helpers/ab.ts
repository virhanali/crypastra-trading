import {
  DEFAULT_JEV_VETO_CONFIG,
  EVALUATION_VERSION,
  JEV_EVALUATOR_VERSION,
  JEV_PROMPT_VERSION,
  JEV_SCHEMA_VERSION,
  JevTreatment,
  NoTreatment,
  buildJevInput,
  collectJevEvaluations,
  evaluateTrades,
  jevInputHash,
  virtualClock,
  type BtcContext,
  type EvaluatorName,
  type MarketObservation,
} from "@crypastra/core";
import { DeterministicFakeJevAdapter } from "@crypastra/adapters";
import { AnalyticsService } from "../../apps/server/src/analytics/analytics-service.js";
import { DecisionService } from "../../apps/server/src/decision/decision-service.js";
import { TradeExecutionService } from "../../apps/server/src/execution/trade-execution-service.js";
import { AutonomousTradeTracker } from "../../apps/server/src/execution/autonomous-trade-tracker.js";
import { MarketRecorder } from "../../apps/server/src/market/market-recorder.js";
import {
  MarketObservationRepository,
  RecordingSessionRepository,
} from "../../apps/server/src/repositories/market-observation-repository.js";
import { ReplayService } from "../../apps/server/src/services/replay-service.js";
import { AccountRepository } from "../../apps/server/src/repositories/account-repository.js";
import { ContractRepository } from "../../apps/server/src/repositories/contract-repository.js";
import { LedgerRepository } from "../../apps/server/src/repositories/ledger-repository.js";
import { FeatureSnapshotRepository } from "../../apps/server/src/repositories/feature-snapshot-repository.js";
import { ScannerResultRepository } from "../../apps/server/src/repositories/scanner-result-repository.js";
import { JevEvaluationRepository } from "../../apps/server/src/repositories/jev-evaluation-repository.js";
import { TreatmentResultRepository } from "../../apps/server/src/repositories/treatment-result-repository.js";
import { TradeRecordRepository } from "../../apps/server/src/repositories/trade-record-repository.js";
import { autonomousScenarioCandles } from "./candles.js";
import { openTempDatabase } from "./db.js";
import { BTC_USDT } from "./fixtures.js";

const T0 = 1_700_000_000_000;
const ACCOUNT = "acct-ab";
const EVALUATORS: EvaluatorName[] = ["trend_alignment", "momentum_sustainability", "reversal_risk"];

/**
 * Harness A/B in-process untuk test: merekam skenario golden BTC sekali per
 * pemanggilan, lalu menjalankan arm kontrol atau arm perlakuan.
 */
export async function runReplay(mode: "control" | "treatment") {
  const db = openTempDatabase();
  new ContractRepository(db.connection).upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
  const account = new AccountRepository(db.connection).create({
    id: ACCOUNT, name: "ab", mode: "simulation", initialBalance: "1000", createdAtMs: 1,
  });
  new LedgerRepository(db.connection).append({
    accountId: account.id, tsMs: 1, type: "deposit", amount: "0", idempotencyKey: `${account.id}:seed`,
  });
  const recorder = new MarketRecorder({
    sessions: new RecordingSessionRepository(db.connection, () => "sess-ab"),
    observations: new MarketObservationRepository(db.connection),
  });
  const sessionId = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: T0 });
  for (const candle of autonomousScenarioCandles("BTC_USDT")) {
    const at = candle.openTimeSeconds * 1000;
    const price = Number(candle.c);
    recorder.record(sessionId, {
      kind: "quote", contract: "BTC_USDT", sourceTimestampMs: at, observedAtMs: at,
      bestBid: (price * 0.9995).toFixed(4), bestBidSize: 900,
      bestAsk: (price * 1.0005).toFixed(4), bestAskSize: 900,
    } satisfies MarketObservation, at);
    recorder.record(sessionId, {
      kind: "mark", contract: "BTC_USDT", sourceTimestampMs: at, observedAtMs: at,
      markPrice: String(price), lastPrice: String(price), indexPrice: String(price),
    } satisfies MarketObservation, at + 1);
    recorder.record(sessionId, {
      kind: "candle", contract: "BTC_USDT", sourceTimestampMs: at, observedAtMs: at,
      interval: candle.interval, openTimeSeconds: candle.openTimeSeconds, open: candle.o,
      high: candle.h, low: candle.l, close: candle.c, volume: candle.v, closed: true,
    } satisfies MarketObservation, at + 2);
  }
  recorder.stopSession(T0 + 100 * 24 * 3600_000);

  const clock = virtualClock(T0);
  const store = new JevEvaluationRepository(db.connection);

  // Arm kontrol dijalankan lebih dulu untuk mendapatkan daftar kandidat.
  const analytics = new AnalyticsService({ connection: db.connection, clock, persist: true });
  const decisions = new DecisionService({ connection: db.connection, clock, persist: true });
  const execution = new TradeExecutionService({ connection: db.connection, accountId: ACCOUNT, enabled: true });
  const tracker = new AutonomousTradeTracker({ connection: db.connection, clock });
  const treatmentResults = new TreatmentResultRepository(db.connection);
  const treatment =
    mode === "control"
      ? new NoTreatment()
      : new JevTreatment({
          store, config: DEFAULT_JEV_VETO_CONFIG, provider: "fake", model: "deterministic-v1",
        });

  // Collect dijalankan sebelum arm treatment, memakai kandidat dari artefak
  // (dihitung dari rekaman yang sama secara deterministik).
  if (mode === "treatment") {
    const collector = new AnalyticsService({ connection: db.connection, clock, persist: false });
    const fake = new DeterministicFakeJevAdapter();
    const pending: Array<{ inputHash: string; input: ReturnType<typeof buildJevInput> }> = [];
    collector.setScannerResultHandler(({ snapshot: features, result, btcContext }) => {
      if (result.status !== "candidate" || result.signal === "neutral") return;
      const jevInput = buildJevInput({
        features, scanner: result, btcContext: btcContext as BtcContext | null, direction: result.signal,
      });
      pending.push({ inputHash: jevInputHash(jevInput), input: jevInput });
    });
    // Jalankan collector secara sinkron atas candle yang sama.
    const collectorDb = new MarketObservationRepository(db.connection).list(sessionId, { limit: 1_000_000 });
    for (const row of collectorDb) {
      const observation = row.observation;
      if (observation.kind !== "candle" || !observation.closed) continue;
      collector.onClosedCandle({
        contract: observation.contract, interval: observation.interval,
        openTimeSeconds: observation.openTimeSeconds, o: observation.open, h: observation.high,
        l: observation.low, c: observation.close, v: observation.volume, sum: "0", windowClosed: true,
      });
    }
    for (const entry of pending) {
      await collectJevEvaluations(entry, {
        port: fake, store, evaluators: EVALUATORS, timeoutMs: 0, clock: { nowMs: () => 0 },
      });
    }
  }

  const service = new ReplayService({
    target: db.connection, analytics, decisions, execution, tracker, treatment,
    onTreatment: (result) => treatmentResults.insertIfAbsent(result, 0),
  });
  const result = service.run({ sessionId, accountId: ACCOUNT });
  const records = new TradeRecordRepository(db.connection).list({ accountId: ACCOUNT });
  const metrics = evaluateTrades({ trades: records, startingEquity: "1000", evaluationVersion: EVALUATION_VERSION });
  const treatmentStatuses = treatmentResults.list().map((row) => [row.candleCloseTimeMs, row.status, row.reasons]);
  const featureSnapshots = new FeatureSnapshotRepository(db.connection).count();
  const scannerCount = new ScannerResultRepository(db.connection).count();
  db.cleanup();
  void JEV_EVALUATOR_VERSION; void JEV_PROMPT_VERSION; void JEV_SCHEMA_VERSION;
  return { result, records, metrics, treatmentStatuses, featureSnapshots, scannerCount };
}
