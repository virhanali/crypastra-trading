import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DECISION_VERSION, virtualClock, type MarketObservation } from "../packages/core/src/index.js";
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import { DecisionService } from "../apps/server/src/decision/decision-service.js";
import { DecisionRepository } from "../apps/server/src/repositories/decision-repository.js";
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
import { account, market, policy, scannerResult, snapshot } from "./helpers/decision.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";
import { BTC_USDT } from "./helpers/fixtures.js";

const dbs: TempDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.cleanup();
});

function fixedClock(startMs = 1_800_000_000_000) {
  let now = startMs;
  return { nowMs: () => now, advance: (ms: number) => { now += ms; } };
}

const ECONOMIC_TABLES = [
  "orders",
  "order_events",
  "fills",
  "positions",
  "position_events",
  "ledger",
  "account_balances",
  "trade_commands",
];

function countRows(db: TempDatabase, table: string): number {
  const row = db.connection.sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number } | null;
  return row?.n ?? 0;
}

function evaluate(defaults: Parameters<typeof decisionInput>[0] = {}) {
  return decisionInput(defaults)();
}

function decisionInput(overrides: {
  contract?: string;
  candleCloseTimeMs?: number;
  features?: Parameters<typeof snapshot>[0];
  scanner?: Parameters<typeof scannerResult>[0];
  account?: Parameters<typeof account>[0];
  policy?: Parameters<typeof policy>[0];
  market?: Parameters<typeof market>[0];
} = {}) {
  const features = snapshot(overrides.features ?? {});
  const scanner = scannerResult({ contract: overrides.contract ?? "BTC_USDT", ...(overrides.scanner ?? {}) });
  return () => ({
    contract: overrides.contract ?? "BTC_USDT",
    timeframe: "5m",
    candleCloseTimeMs: overrides.candleCloseTimeMs ?? features.candleCloseTimeMs,
    accountId: "acct-1",
    features,
    scanner,
    spec: BTC_USDT,
    market: market(overrides.market ?? {}),
    account: account(overrides.account ?? {}),
  });
}

describe("Phase 10 — DecisionService: persistensi & idempotensi", () => {
  test("keputusan TRADE dan SKIP sama-sama dipersist", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const clock = fixedClock();
    const service = new DecisionService({ connection: db.connection, clock });

    service.evaluate(evaluate({ candleCloseTimeMs: 1_700_000_300_000 }));
    service.evaluate(evaluate({ candleCloseTimeMs: 1_700_000_600_000, features: { atr14: null, atrPercent: null } }));
    service.evaluate(evaluate({ candleCloseTimeMs: 1_700_000_900_000, scanner: { signal: "neutral" } }));

    const stats = service.counters();
    expect(stats.decisionsEvaluated).toBe(3);
    expect(stats.approved).toBe(1);
    expect(stats.skipped).toBe(2);
    expect(stats.persisted).toBe(3);
    expect(service.persistedCount()).toBe(3);
  });

  test("candle yang sama diproses ulang tidak menggandakan keputusan", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const service = new DecisionService({ connection: db.connection, clock: fixedClock() });
    const input = evaluate();
    service.evaluate(input);
    service.evaluate(input);
    service.evaluate(input);
    expect(service.counters().decisionsEvaluated).toBe(3);
    expect(service.persistedCount()).toBe(1);
  });

  test("id deterministik dan stabil antar instance", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const key = {
      accountId: "acct-1",
      contract: "BTC_USDT",
      interval: "5m",
      candleCloseT: 1_700_000_300_000,
      decisionVersion: DECISION_VERSION,
      scannerVersion: "scanner-v1",
      scannerConfigHash: "abc",
      riskPolicyHash: "def",
    };
    expect(DecisionRepository.idFor(key)).toBe(DecisionRepository.idFor(key));
    expect(DecisionRepository.idFor(key)).not.toBe(
      DecisionRepository.idFor({ ...key, candleCloseT: key.candleCloseT + 1 }),
    );
  });

  test("satu candle berbeda → keputusan berbeda", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const service = new DecisionService({ connection: db.connection, clock: fixedClock() });
    service.evaluate(evaluate({ candleCloseTimeMs: 1_700_000_300_000 }));
    service.evaluate(evaluate({ candleCloseTimeMs: 1_700_000_600_000 }));
    expect(service.persistedCount()).toBe(2);
  });

  test("kegagalan keputusan tidak melempar keluar", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const service = new DecisionService({ connection: db.connection, clock: fixedClock() });
    db.connection.close();
    expect(() => service.evaluate(evaluate())).not.toThrow();
    expect(service.counters().errors).toBeGreaterThan(0);
  });
});

describe("Phase 10 — bukti tanpa eksekusi order", () => {
  test("100 evaluasi tidak mengubah satu pun tabel ekonomi", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const contracts = new ContractRepository(db.connection);
    contracts.upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
    const acct = new AccountRepository(db.connection).create({
      name: "decision",
      mode: "simulation",
      initialBalance: "1000",
      createdAtMs: 1,
    });
    new LedgerRepository(db.connection).append({
      accountId: acct.id,
      tsMs: 1,
      type: "deposit",
      amount: "0",
      idempotencyKey: `${acct.id}:seed`,
    });

    const before = ECONOMIC_TABLES.map((table) => countRows(db, table));
    const service = new DecisionService({ connection: db.connection, clock: fixedClock() });
    for (let index = 0; index < 100; index += 1) {
      service.evaluate(evaluate({ candleCloseTimeMs: 1_700_000_000_000 + index * 300_000 }));
    }
    const after = ECONOMIC_TABLES.map((table) => countRows(db, table));

    expect(after).toEqual(before);
    expect(service.counters().approved).toBe(100);
    expect(service.persistedCount()).toBe(100);
  });

  test("evaluasi tidak menyentuh saldo akun", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const contracts = new ContractRepository(db.connection);
    contracts.upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
    const acct = new AccountRepository(db.connection).create({
      name: "decision",
      mode: "simulation",
      initialBalance: "1000",
      createdAtMs: 1,
    });
    const ledger = new LedgerRepository(db.connection);
    const before = ledger.balances(acct.id);
    new DecisionService({ connection: db.connection, clock: fixedClock() })
      .evaluate(evaluate({ account: { accountId: acct.id } }));
    const after = ledger.balances(acct.id);
    expect(after.walletBalance.toString()).toBe(before.walletBalance.toString());
    expect(after.usedMargin.toString()).toBe(before.usedMargin.toString());
  });
});

describe("Phase 10 — isolasi arsitektur", () => {
  test("inti decision murni: tanpa DB/order/ledger/waktu/acak", () => {
    const dir = "packages/core/src/decision";
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const forbidden = [
      "Date.now(",
      "Math.random(",
      "node:crypto",
      "drizzle",
      "order-service",
      "position-service",
      "ledger",
      "repositories",
      "fastify",
      "WebSocket",
      "@crypastra/adapters",
      "apps/server",
    ];
    for (const file of files) {
      const source = stripComments(readFileSync(join(dir, file), "utf8"));
      for (const token of forbidden) {
        expect(source.includes(token)).toBe(false);
      }
      const pureDeps = new Set(["zod", "decimal.js"]);
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        expect(specifier.startsWith(".") || pureDeps.has(specifier)).toBe(true);
      }
    }
  });

  test("lapisan keputusan server tidak mengimpor OrderService/PositionService/LedgerRepository", () => {
    for (const file of ["decision-service.ts", "decision-coordinator.ts"]) {
      const source = stripComments(readFileSync(join("apps/server/src/decision", file), "utf8"));
      for (const token of [
        "order-service",
        "position-service",
        "mark-to-market-service",
        "realtime",
        "OrderService",
        "PositionService",
        "MarkToMarketService",
      ]) {
        expect(source.includes(token)).toBe(false);
      }
      // LedgerRepository boleh HANYA untuk membaca saldo, bukan menulis.
      expect(source).not.toContain(".append(");
      expect(source).not.toContain("OrderService");
    }
  });

  test("tidak ada jalur keputusan yang mengimpor OrderService di seluruh apps/server", () => {
    const dir = "apps/server/src/decision";
    for (const file of readdirSync(dir)) {
      const source = stripComments(readFileSync(join(dir, file), "utf8"));
      expect(source.includes("submitOrder")).toBe(false);
      expect(source.includes("OrderIntent")).toBe(false);
    }
  });
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Phase 10 — integrasi replay", () => {
  function recordSession(): { sessionId: string; accountId: string; db: TempDatabase } {
    const db = openTempDatabase();
    dbs.push(db);
    new ContractRepository(db.connection).upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
    // Id akun DIPATOK: id acak akan mengubah decisionHash antar run dan
    // menyamarkan determinisme engine yang sebenarnya.
    const acct = new AccountRepository(db.connection).create({
      id: "acct-replay-fixed",
      name: "replay-decisions",
      mode: "simulation",
      initialBalance: "1000",
      createdAtMs: 1,
    });
    new LedgerRepository(db.connection).append({
      accountId: acct.id,
      tsMs: 1,
      type: "deposit",
      amount: "0",
      idempotencyKey: `${acct.id}:seed`,
    });

    const recorder = new MarketRecorder({
      sessions: new RecordingSessionRepository(db.connection, () => "sess-decisions"),
      observations: new MarketObservationRepository(db.connection),
    });
    const sessionId = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: 1_700_000_000_000 });

    for (const candle of bullishSetupCandles("BTC_USDT")) {
      const at = candle.openTimeSeconds * 1000;
      const price = Number(candle.c);
      const bid = (price * 0.9999).toFixed(4);
      const ask = (price * 1.0001).toFixed(4);
      // Kutipan direkam SEBELUM candle ditutup supaya sudah terlihat saat sinyal lahir.
      recorder.record(sessionId, {
        kind: "quote", contract: "BTC_USDT", sourceTimestampMs: at, observedAtMs: at,
        bestBid: bid, bestBidSize: 500, bestAsk: ask, bestAskSize: 500,
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
    recorder.stopSession(1_700_100_000_000);
    return { sessionId, accountId: acct.id, db };
  }

  function runReplay(input: { sessionId: string; accountId: string; db: TempDatabase }, withDecisions: boolean) {
    const clock = virtualClock(1_700_000_000_000);
    const analytics = new AnalyticsService({ connection: input.db.connection, clock, persist: true });
    const decisions = withDecisions
      ? new DecisionService({ connection: input.db.connection, clock, persist: true })
      : undefined;
    const service = new ReplayService({
      target: input.db.connection,
      analytics,
      ...(decisions === undefined ? {} : { decisions }),
    });
    const result = service.run({ sessionId: input.sessionId, accountId: input.accountId });
    return { result, decisions, analytics };
  }

  test("replay menjalankan lapisan keputusan yang sama", () => {
    const { result, decisions } = runReplay(recordSession(), true);
    expect(result.decisions).toBeDefined();
    expect(result.decisions!.digest.evaluated).toBeGreaterThan(0);
    expect(decisions!.counters().decisionsEvaluated).toBe(result.decisions!.digest.evaluated);
    expect(result.decisions!.digest.combinedHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("dua replay menghasilkan keputusan identik", () => {
    const a = runReplay(recordSession(), true);
    const b = runReplay(recordSession(), true);
    expect(a.result.decisions!.digest.combinedHash).toBe(b.result.decisions!.digest.combinedHash);
    expect(a.result.decisions!.digest.reasonCodeCounts).toEqual(b.result.decisions!.digest.reasonCodeCounts);
    expect(a.result.decisions!.counters).toEqual(b.result.decisions!.counters);
  });

  test("keputusan tidak mengubah hash ekonomi replay", () => {
    const withD = runReplay(recordSession(), true);
    const withoutD = runReplay(recordSession(), false);
    expect(withD.result.hashes).toEqual(withoutD.result.hashes);
    expect(withD.result.balances).toEqual(withoutD.result.balances);
    expect(withoutD.result.decisions).toBeUndefined();
  });

  test("akun replay tetap tidak berubah karena keputusan tidak mengeksekusi", () => {
    const input = recordSession();
    const { result } = runReplay(input, true);
    const balances = new LedgerRepository(input.db.connection).balances(input.accountId);
    expect(result.decisions!.digest.approved).toBeGreaterThan(0);
    expect(balances.usedMargin.toString()).toBe("0");
    expect(balances.walletBalance.toString()).toBe("1000");
  });
});
