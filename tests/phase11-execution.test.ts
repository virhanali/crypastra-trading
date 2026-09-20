import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RISK_POLICY,
  EVALUATION_VERSION,
  decide,
  evaluateTrades,
  virtualClock,
  type BookSnapshot,
  type Decision,
  type MarketObservation,
} from "@crypastra/core";
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import { DecisionService } from "../apps/server/src/decision/decision-service.js";
import { TradeExecutionService } from "../apps/server/src/execution/trade-execution-service.js";
import { AutonomousTradeTracker } from "../apps/server/src/execution/autonomous-trade-tracker.js";
import { DecisionExecutionRepository } from "../apps/server/src/repositories/decision-execution-repository.js";
import { TradeRecordRepository } from "../apps/server/src/repositories/trade-record-repository.js";
import { MarkToMarketService } from "../apps/server/src/services/mark-to-market-service.js";
import { MarketRecorder } from "../apps/server/src/market/market-recorder.js";
import {
  MarketObservationRepository,
  RecordingSessionRepository,
} from "../apps/server/src/repositories/market-observation-repository.js";
import { ReplayService } from "../apps/server/src/services/replay-service.js";
import { AccountRepository } from "../apps/server/src/repositories/account-repository.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { LedgerRepository } from "../apps/server/src/repositories/ledger-repository.js";
import { PositionRepository } from "../apps/server/src/repositories/position-repository.js";
import { autonomousScenarioCandles } from "./helpers/candles.js";
import { account, market, scannerResult, snapshot } from "./helpers/decision.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";
import { BTC_USDT } from "./helpers/fixtures.js";

const dbs: TempDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.cleanup();
});

const T0 = 1_700_000_000_000;
const ECONOMIC_TABLES = [
  "orders", "order_events", "fills", "positions", "position_events",
  "ledger", "account_balances", "trade_commands",
];

function setupAccount(db: TempDatabase, id = "acct-auto"): string {
  new ContractRepository(db.connection).upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
  const acct = new AccountRepository(db.connection).create({
    id, name: "auto", mode: "simulation", initialBalance: "1000", createdAtMs: 1,
  });
  new LedgerRepository(db.connection).append({
    accountId: acct.id, tsMs: 1, type: "deposit", amount: "0", idempotencyKey: `${acct.id}:seed`,
  });
  return acct.id;
}

function countRows(db: TempDatabase, table: string): number {
  const row = db.connection.sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number } | null;
  return row?.n ?? 0;
}

function approvedDecision(overrides: { signal?: "long" | "short"; atr?: string; candleCloseTimeMs?: number } = {}): Decision {
  const signal = overrides.signal ?? "long";
  const features = snapshot({
    atr14: overrides.atr ?? "400",
    trendStructure: signal === "long" ? "bullish" : "bearish",
    candleCloseTimeMs: overrides.candleCloseTimeMs ?? 1_700_000_300_000,
  });
  return decide({
    contract: "BTC_USDT",
    timeframe: "5m",
    candleCloseTimeMs: features.candleCloseTimeMs,
    accountId: "acct-auto",
    features,
    scanner: scannerResult({ signal }),
    spec: BTC_USDT,
    market: market(signal === "long" ? { bestAsk: "80000", bestBid: "79995" } : { bestBid: "80000", bestAsk: "80005" }),
    account: account(),
    policy: DEFAULT_RISK_POLICY,
  });
}

function book(contract: string, bid: string, ask: string): BookSnapshot {
  return {
    contract, updateId: 1, eventTsMs: T0,
    bids: [{ price: bid, size: 10_000 }],
    asks: [{ price: ask, size: 10_000 }],
  };
}

describe("Phase 11 — gate eksekusi", () => {
  test("gate OFF: keputusan disetujui tetap tidak menghasilkan ekonomi apa pun", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: false });

    const before = ECONOMIC_TABLES.map((table) => countRows(db, table));
    for (let index = 0; index < 50; index += 1) {
      const outcome = execution.executeApprovedDecision({
        decision: approvedDecision({ candleCloseTimeMs: T0 + index * 300_000 }),
        spec: BTC_USDT,
        book: book("BTC_USDT", "79995", "80000"),
        nowMs: T0 + index * 300_000,
      });
      expect(outcome).toBeNull();
    }
    const after = ECONOMIC_TABLES.map((table) => countRows(db, table));

    expect(after).toEqual(before);
    // Gate OFF juga tidak menulis linkage apa pun: lapisan benar-benar inert.
    expect(new DecisionExecutionRepository(db.connection).count()).toBe(0);
    expect(execution.counters().executionAttempts).toBe(0);
    expect(execution.counters().executionRefused).toBe(50);
  });

  test("gate ON: keputusan disetujui dieksekusi lewat OrderService PAPER", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const outcome = execution.executeApprovedDecision({
      decision: approvedDecision(), spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0,
    });
    expect(outcome!.status).toBe("filled");
    expect(countRows(db, "orders")).toBe(1);
    expect(countRows(db, "positions")).toBe(1);
    expect(execution.counters().executionFilled).toBe(1);
  });

  test("keputusan SKIP tidak pernah dapat dieksekusi (10.000 evaluasi)", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const skip = decide({
      contract: "BTC_USDT", timeframe: "5m", candleCloseTimeMs: T0, accountId,
      features: snapshot(), scanner: scannerResult({ signal: "neutral" }), spec: BTC_USDT,
      market: market(), account: account(), policy: DEFAULT_RISK_POLICY,
    });
    expect(skip.action).toBe("skip");

    const before = ECONOMIC_TABLES.map((table) => countRows(db, table));
    for (let index = 0; index < 10_000; index += 1) {
      const outcome = execution.executeApprovedDecision({
        decision: { ...skip, candleCloseTimeMs: T0 + index * 1000 },
        spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0,
      });
      expect(outcome!.status).toBe("skipped");
      expect(outcome!.errorCode).toBe("DECISION_NOT_APPROVED");
    }
    expect(ECONOMIC_TABLES.map((table) => countRows(db, table))).toEqual(before);
    expect(execution.counters().executionAttempts).toBe(0);
    expect(execution.counters().executionFilled).toBe(0);
  }, 120_000);

  test("kutipan tidak tersedia → tidak mengarang eksekusi", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const outcome = execution.executeApprovedDecision({
      decision: approvedDecision(), spec: BTC_USDT, book: null, nowMs: T0,
    });
    expect(outcome!.status).toBe("skipped");
    expect(outcome!.errorCode).toBe("QUOTE_UNAVAILABLE");
    expect(countRows(db, "orders")).toBe(0);
  });

  test("ukuran pecahan pada kontrak integer ditolak oleh OrderService, bukan oleh lapisan eksekusi", () => {
    // Phase 11.5: kelayakan ukuran kini SADAR KONTRAK. Lapisan eksekusi tidak
    // lagi menolak pecahan; BTC_USDT (enable_decimal=false) yang menolaknya,
    // dan penolakan itu terekam sebagai order rejected (audit).
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const decision = approvedDecision();
    const withDecimal = { ...decision, tradePlan: { ...decision.tradePlan!, size: 12.5 } };
    const outcome = execution.executeApprovedDecision({
      decision: withDecimal, spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0,
    });
    expect(outcome!.status).toBe("rejected");
    expect(outcome!.errorCode).toBe("ORDER_REJECTED");
    expect(countRows(db, "orders")).toBe(1);
    expect(countRows(db, "positions")).toBe(0);
  });

  test("ukuran tidak sah (nol/negatif) tetap SIZE_NOT_EXECUTABLE", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const decision = approvedDecision();
    for (const size of [0, -5]) {
      const outcome = execution.executeApprovedDecision({
        decision: { ...decision, tradePlan: { ...decision.tradePlan!, size } },
        spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0,
      });
      expect(outcome!.status).toBe("skipped");
      expect(outcome!.errorCode).toBe("SIZE_NOT_EXECUTABLE");
    }
    expect(countRows(db, "orders")).toBe(0);
  });
});

describe("Phase 11 — idempotensi & keamanan restart", () => {
  test("keputusan sama tidak pernah menghasilkan order kedua", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const decision = approvedDecision();

    const first = execution.executeApprovedDecision({ decision, spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0 });
    expect(first!.status).toBe("filled");
    const second = execution.executeApprovedDecision({ decision, spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0 + 1000 });
    const third = execution.executeApprovedDecision({ decision, spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0 + 2000 });

    expect(second!.duplicate).toBe(true);
    expect(third!.duplicate).toBe(true);
    expect(countRows(db, "orders")).toBe(1);
    expect(countRows(db, "positions")).toBe(1);
    expect(execution.counters().executionAttempts).toBe(1);
    expect(execution.counters().executionDuplicates).toBe(2);
  });

  test("restart proses: instance baru memakai command id deterministik yang sama", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const decision = approvedDecision();

    const before = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const first = before.executeApprovedDecision({ decision, spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0 });
    expect(first!.status).toBe("filled");
    const commandId = first!.commandId;
    expect(commandId).toBe(`auto-entry:${first!.decisionId}`);

    // Simulasi restart: proses baru, instance baru, state in-memory kosong.
    const after = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const retry = after.executeApprovedDecision({ decision, spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0 + 5000 });
    expect(retry!.duplicate).toBe(true);
    expect(retry!.commandId).toBe(commandId);
    expect(countRows(db, "orders")).toBe(1);
    expect(countRows(db, "fills")).toBe(1);
  });

  test("command id tidak berubah walau payload diretry dengan harga buku berbeda", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const decision = approvedDecision();
    const first = execution.executeApprovedDecision({ decision, spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0 });
    const retry = execution.executeApprovedDecision({ decision, spec: BTC_USDT, book: book("BTC_USDT", "70000", "70005"), nowMs: T0 + 1 });
    expect(retry!.duplicate).toBe(true);
    expect(countRows(db, "orders")).toBe(1);
    expect(first!.commandId).toBe(retry!.commandId);
  });

  test("kegagalan ekonomi tercatat sebagai rejected, bukan failed", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    // Penolakan EKONOMI: ukuran melanggar batas kontrak. OrderService membaca
    // spec dari DB, jadi batasnya diubah di DB — dan OrderService yang menolak.
    new ContractRepository(db.connection).upsert({
      spec: { ...BTC_USDT, orderSizeMin: 1_000_000 }, rawJson: "{}", updatedAtMs: 2,
    });
    const outcome = execution.executeApprovedDecision({
      decision: approvedDecision(),
      spec: BTC_USDT,
      book: book("BTC_USDT", "79995", "80000"),
      nowMs: T0,
    });
    expect(outcome!.status).toBe("rejected");
    expect(outcome!.errorCode).toBe("ORDER_REJECTED");
    expect(outcome!.errorDetail).not.toBeNull();
    const row = new DecisionExecutionRepository(db.connection).list()[0]!;
    expect(row.status).toBe("rejected");
    expect(countRows(db, "positions")).toBe(0);
    expect(execution.counters().executionRejected).toBe(1);
    expect(execution.counters().executionFailed).toBe(0);
  });

  test("kegagalan sistem tercatat sebagai failed, terpisah dari penolakan ekonomi", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    db.connection.close();
    const outcome = execution.executeApprovedDecision({
      decision: approvedDecision(), spec: BTC_USDT, book: book("BTC_USDT", "79995", "80000"), nowMs: T0,
    });
    expect(outcome!.status).toBe("failed");
    expect(outcome!.errorCode).toBe("EXECUTION_FAILED");
    expect(execution.counters().executionFailed).toBe(1);
    expect(execution.counters().executionRejected).toBe(0);
  });
});

describe("Phase 11 — SHORT dan exit SL (terarah)", () => {
  test("entry SHORT terisi dan SL kena → TradeRecord rugi dengan exit stop_loss", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const tracker = new AutonomousTradeTracker({ connection: db.connection, clock: { nowMs: () => T0 } });
    const decision = approvedDecision({ signal: "short" });

    const outcome = execution.executeApprovedDecision({
      decision, spec: BTC_USDT, book: book("BTC_USDT", "80000", "80005"), nowMs: T0,
    });
    expect(outcome!.status).toBe("filled");
    const plan = decision.tradePlan!;
    expect(Number(plan.stopLoss)).toBeGreaterThan(Number(plan.referencePrice));
    expect(Number(plan.takeProfit)).toBeLessThan(Number(plan.referencePrice));

    tracker.register({
      positionId: outcome!.positionId!, decision,
      entryPrice: outcome!.actualFillPrice!, size: plan.size,
      leverage: plan.leverage, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, nowMs: T0,
    });
    expect(tracker.counters().tradesOpened).toBe(1);

    // Mark naik melewati SL SHORT → penutupan paksa oleh Paper Exchange.
    const m2m = new MarkToMarketService({ connection: db.connection });
    m2m.processMark({
      commandId: "mark-1", accountId,
      mark: { contract: "BTC_USDT", markPrice: "81000", observedAtMs: T0 + 60_000, sourceTimestampMs: T0 + 60_000 },
      execution: { contract: "BTC_USDT", bidPrice: "80990", askPrice: "81010" },
      nowMs: T0 + 60_000,
    });
    tracker.onMark("BTC_USDT", "81000", T0 + 60_000);
    tracker.settle(T0 + 60_000);

    const records = tracker.closedRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.side).toBe("short");
    expect(record.exitReason).toBe("stop_loss");
    expect(Number(record.netPnl)).toBeLessThan(0);
    expect(Number(record.actualInitialRiskAmount)).toBeGreaterThan(0);
    expect(Number(record.rMultiple)).toBeLessThan(0);
    expect(Number(record.mae)).toBeGreaterThan(0);

    const persisted = new TradeRecordRepository(db.connection).list();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.exitReason).toBe("stop_loss");
  });
});

describe("Phase 11 — isolasi & keamanan", () => {
  test("tidak ada endpoint privat Gate atau kredensial di jalur eksekusi", () => {
    const dir = "apps/server/src/execution";
    const forbidden = [
      "gateio.ws", "api.gateio", "GATE_API_KEY", "GATE_API_SECRET", "apiKey", "apiSecret",
      "signature", "private", "withdraw", "OrderService} from", "fetch(",
    ];
    for (const file of readdirSync(dir)) {
      const source = stripComments(readFileSync(join(dir, file), "utf8"));
      for (const token of forbidden) {
        expect(source.includes(token)).toBe(false);
      }
    }
  });

  test("execution hanya mengimpor OrderService PAPER, bukan layanan lain", () => {
    const source = stripComments(readFileSync("apps/server/src/execution/trade-execution-service.ts", "utf8"));
    expect(source).toContain("order-service");
    for (const token of ["mark-to-market-service", "account-service", "position-service", "realtime", "gate"]) {
      expect(source.includes(token)).toBe(false);
    }
  });

  test("tidak ada Jev / LLM di lapisan eksekusi & evaluasi", () => {
    for (const dir of ["apps/server/src/execution", "packages/core/src/evaluation"]) {
      for (const file of readdirSync(dir)) {
        const source = stripComments(readFileSync(join(dir, file), "utf8"));
        for (const token of ["jev", "Jev", "openai", "anthropic", "llm", "confidence"]) {
          expect(source.includes(token)).toBe(false);
        }
      }
    }
  });
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Phase 11 — replay otonom golden", () => {
  function recordScenario(): { sessionId: string; accountId: string; db: TempDatabase } {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db, "acct-golden");
    const recorder = new MarketRecorder({
      sessions: new RecordingSessionRepository(db.connection, () => "sess-autonomous"),
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
    return { sessionId, accountId, db };
  }

  function runAutonomous(input: { sessionId: string; accountId: string; db: TempDatabase }, executionEnabled: boolean) {
    const clock = virtualClock(T0);
    const analytics = new AnalyticsService({ connection: input.db.connection, clock, persist: true });
    const decisions = new DecisionService({ connection: input.db.connection, clock, persist: true });
    const tracker = new AutonomousTradeTracker({ connection: input.db.connection, clock });
    const execution = new TradeExecutionService({
      connection: input.db.connection, accountId: input.accountId, enabled: executionEnabled,
      idFactories: {
        orderIdFactory: (() => { let n = 0; return () => `auto:order:${(n += 1)}`; })(),
        fillIdFactory: (() => { let n = 0; return () => `auto:fill:${(n += 1)}`; })(),
        positionIdFactory: (() => { let n = 0; return () => `auto:position:${(n += 1)}`; })(),
      },
    });
    const service = new ReplayService({ target: input.db.connection, analytics, decisions, execution, tracker });
    const result = service.run({ sessionId: input.sessionId, accountId: input.accountId });
    const records = new TradeRecordRepository(input.db.connection).list();
    return {
      result, tracker, execution, decisions, records,
      metrics: evaluateTrades({ trades: records, startingEquity: "1000", evaluationVersion: EVALUATION_VERSION }),
    };
  }

  test("skenario menghasilkan entry LONG yang ditutup TP dan sinyal yang ditolak saat posisi terbuka", () => {
    const run = runAutonomous(recordScenario(), true);
    expect(run.result.autonomous!.execution.executionFilled).toBe(1);
    expect(run.records).toHaveLength(1);
    const record = run.records[0]!;
    expect(record.side).toBe("long");
    expect(record.exitReason).toBe("take_profit");
    expect(record.size).toBe(72);
    expect(record.actualEntry).toBe("86498.7731");
    expect(record.stopLoss).toBe("85123");
    expect(record.takeProfit).toBe("89250.3");
    expect(record.plannedRiskAmount).toBe("9.90556632");
    // Tanpa drift: harga isian sama dengan acuan perencanaan pada fixture ini.
    expect(record.actualInitialRiskAmount).toBe(record.plannedRiskAmount);
    expect(Number(record.rMultiple)).toBeGreaterThan(2);
    expect(run.metrics.tradeCount).toBe(1);
    expect(run.metrics.wins).toBe(1);
    expect(run.metrics.profitFactor).toBeNull();
    expect(run.metrics.tpExits).toBe(1);
    // Batas posisi benar-benar mengikat: sinyal berikutnya ditolak.
    expect(run.decisions.counters().skipByReason.EXISTING_CONTRACT_POSITION).toBeGreaterThan(0);
  });

  test("dua replay otonom menghasilkan ekonomi, trade record, dan metrik identik", () => {
    const a = runAutonomous(recordScenario(), true);
    const b = runAutonomous(recordScenario(), true);

    expect(a.result.hashes).toEqual(b.result.hashes);
    expect(a.result.balances).toEqual(b.result.balances);
    expect(a.result.orderCount).toBe(b.result.orderCount);
    expect(a.result.fillCount).toBe(b.result.fillCount);
    expect(a.result.ledgerCount).toBe(b.result.ledgerCount);
    expect(a.records).toEqual(b.records);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.decisions.digest().combinedHash).toBe(b.decisions.digest().combinedHash);
    expect(a.execution.counters()).toEqual(b.execution.counters());
    expect(a.tracker.counters()).toEqual(b.tracker.counters());
  }, 120_000);

  test("A/B: eksekusi OFF tidak membuat ekonomi, ON membuatnya", () => {
    const off = runAutonomous(recordScenario(), false);
    const on = runAutonomous(recordScenario(), true);

    expect(off.result.orderCount).toBe(0);
    expect(off.result.fillCount).toBe(0);
    expect(off.records).toHaveLength(0);
    expect(off.metrics.tradeCount).toBe(0);
    // Keputusan tetap ada walau eksekusi mati.
    expect(off.decisions.counters().approved).toBeGreaterThan(0);
    expect(off.result.autonomous!.execution.executionAttempts).toBe(0);

    expect(on.result.orderCount).toBeGreaterThan(0);
    expect(on.records.length).toBeGreaterThan(0);
  });

  test("skenario tanpa trade menghasilkan evaluasi kosong yang valid", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setupAccount(db, "acct-zero");
    const recorder = new MarketRecorder({
      sessions: new RecordingSessionRepository(db.connection, () => "sess-zero"),
      observations: new MarketObservationRepository(db.connection),
    });
    const sessionId = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: T0 });
    // Pasar datar: tidak ada sinyal, tidak ada trade.
    for (let index = 0; index < 220; index += 1) {
      const at = T0 + index * 300_000;
      recorder.record(sessionId, {
        kind: "quote", contract: "BTC_USDT", sourceTimestampMs: at, observedAtMs: at,
        bestBid: "80000", bestBidSize: 900, bestAsk: "80001", bestAskSize: 900,
      } satisfies MarketObservation, at);
      recorder.record(sessionId, {
        kind: "candle", contract: "BTC_USDT", sourceTimestampMs: at, observedAtMs: at,
        interval: "5m", openTimeSeconds: Math.floor(at / 1000), open: "80000", high: "80001",
        low: "79999", close: "80000", volume: 100, closed: true,
      } satisfies MarketObservation, at + 1);
    }
    recorder.stopSession(T0 + 200 * 24 * 3600_000);

    const run = runAutonomous({ sessionId, accountId, db }, true);
    expect(run.result.orderCount).toBe(0);
    expect(run.metrics.tradeCount).toBe(0);
    expect(run.metrics.winRate).toBeNull();
    expect(run.metrics.netPnl).toBe("0");
    expect(run.metrics.maxDrawdown).toBe("0");
    expect(run.metrics.endingEquity).toBe("1000");
  });
});
