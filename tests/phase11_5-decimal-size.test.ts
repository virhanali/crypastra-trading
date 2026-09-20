import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_RISK_POLICY,
  OrderIntentSchema,
  assertValidSize,
  canonicalContractSize,
  decide,
  simulateFill,
  planLevelConsumption,
  planPositionTransition,
  reduceOnlySize,
  virtualClock,
  type BookSnapshot,
} from "@crypastra/core";
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import { DecisionService } from "../apps/server/src/decision/decision-service.js";
import { TradeExecutionService } from "../apps/server/src/execution/trade-execution-service.js";
import { AutonomousTradeTracker } from "../apps/server/src/execution/autonomous-trade-tracker.js";
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
import { DecisionExecutionRepository } from "../apps/server/src/repositories/decision-execution-repository.js";
import { FillRepository } from "../apps/server/src/repositories/fill-repository.js";
import { createAccountViaApi, injectMarket, setupApi, type ApiHarness } from "./helpers/api.js";
import { bullishSetupCandles } from "./helpers/candles.js";
import { account, market, scannerResult, snapshot } from "./helpers/decision.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";
import { BTC_USDT, ETH_USDT } from "./helpers/fixtures.js";

const dbs: TempDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.cleanup();
});

const T0 = 1_700_000_000_000;

function setup(db: TempDatabase, specs: readonly (typeof BTC_USDT)[] = [BTC_USDT, ETH_USDT]): string {
  const contracts = new ContractRepository(db.connection);
  for (const spec of specs) {
    contracts.upsert({ spec, rawJson: "{}", updatedAtMs: 1 });
  }
  const acct = new AccountRepository(db.connection).create({
    id: "acct-dec", name: "dec", mode: "simulation", initialBalance: "1000", createdAtMs: 1,
  });
  new LedgerRepository(db.connection).append({
    accountId: acct.id, tsMs: 1, type: "deposit", amount: "0", idempotencyKey: `${acct.id}:seed`,
  });
  return acct.id;
}

function book(contract: string, bid: string, ask: string, size = 10_000): BookSnapshot {
  return { contract, updateId: 1, eventTsMs: T0, bids: [{ price: bid, size }], asks: [{ price: ask, size }] };
}

describe("Phase 11.5 — validasi ukuran: sintaktis vs kontrak", () => {
  test("skema OrderIntent menerima desimal positif (sintaktis)", () => {
    for (const size of [1, 1.25, 0.5, 1e-8]) {
      const parsed = OrderIntentSchema.safeParse({
        contract: "ETH_USDT", side: "buy", type: "market", size, price: null,
        leverage: "10", timeInForce: "ioc", reduceOnly: false, tpPrice: null, slPrice: null,
      });
      expect(parsed.success).toBe(true);
    }
  });

  test("skema menolak nol, negatif, dan non-hingga", () => {
    for (const size of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        OrderIntentSchema.safeParse({
          contract: "ETH_USDT", side: "buy", type: "market", size, price: null,
          leverage: "10", timeInForce: "ioc", reduceOnly: false, tpPrice: null, slPrice: null,
        }).success,
      ).toBe(false);
    }
  });

  test("kontrak integer MENOLAK pecahan", () => {
    for (const size of [1.5, 0.1, 2.0000001]) {
      expect(() => assertValidSize(BTC_USDT, size)).toThrow();
    }
    expect(assertValidSize(BTC_USDT, 1)).toBe(1);
    expect(assertValidSize(BTC_USDT, 125)).toBe(125);
  });

  test("kontrak desimal MENERIMA pecahan dalam batas", () => {
    expect(assertValidSize(ETH_USDT, 1.25)).toBe(1.25);
    expect(assertValidSize(ETH_USDT, 0.00000001)).toBe(0.00000001);
    expect(assertValidSize(ETH_USDT, Number(ETH_USDT.orderSizeMax))).toBe(Number(ETH_USDT.orderSizeMax));
  });

  test("batas minimum dan maksimum tetap ditegakkan", () => {
    expect(() => assertValidSize(ETH_USDT, Number(ETH_USDT.orderSizeMax) + 1)).toThrow();
    expect(() => assertValidSize({ ...ETH_USDT, orderSizeMin: 2 }, 1.5)).toThrow();
    expect(() => assertValidSize({ ...ETH_USDT, orderSizeMin: 1 }, 0.5)).toThrow();
  });

  test("representasi kanonik menyatukan 1.5 / 1.50 / 1.500", () => {
    expect(canonicalContractSize(1.5)).toBe("1.5");
    expect(canonicalContractSize(1.50)).toBe("1.5");
    expect(canonicalContractSize("1.500")).toBe("1.5");
    expect(canonicalContractSize(2)).toBe("2");
  });
});

describe("Phase 11.5 — matching dengan ukuran pecahan", () => {
  test("konsumsi level tidak melayang untuk ukuran pecahan", () => {
    const levels = [{ price: "100", size: 0.1 }, { price: "100", size: 0.1 }, { price: "100", size: 0.1 }];
    const consumption = planLevelConsumption(0.3, levels);
    expect(consumption.filledSize).toBe(0.3);
    expect(consumption.remainingSize).toBe(0);
    expect(consumption.takes.map((take) => take.size)).toEqual([0.1, 0.1, 0.1]);
  });

  test("market order pecahan terisi penuh", () => {
    const result = simulateFill(
      ETH_USDT,
      {
        contract: "ETH_USDT", side: "buy", type: "market", size: 1.25, price: null,
        leverage: "10", timeInForce: "ioc", reduceOnly: false, tpPrice: null, slPrice: null,
      },
      book("ETH_USDT", "2999", "3000"),
    );
    expect(result.rejected).toBeNull();
    expect(result.filledSize).toBe(1.25);
    expect(result.remainingSize).toBe(0);
    expect(result.avgPrice).toBe("3000");
  });

  test("partial fill pecahan menyisakan ukuran eksak", () => {
    const result = simulateFill(
      ETH_USDT,
      {
        contract: "ETH_USDT", side: "buy", type: "market", size: 1.25, price: null,
        leverage: "10", timeInForce: "ioc", reduceOnly: false, tpPrice: null, slPrice: null,
      },
      book("ETH_USDT", "2999", "3000", 0.5),
    );
    expect(result.filledSize).toBe(0.5);
    expect(result.remainingSize).toBe(0.75);
  });

  test("limit pecahan yang tidak menyentuh buku menjadi resting", () => {
    const result = simulateFill(
      ETH_USDT,
      {
        contract: "ETH_USDT", side: "buy", type: "limit", size: 1.25, price: "2500",
        leverage: "10", timeInForce: "gtc", reduceOnly: false, tpPrice: null, slPrice: null,
      },
      book("ETH_USDT", "2999", "3000"),
    );
    expect(result.restsOnBook).toBe(true);
    expect(result.filledSize).toBe(0);
    expect(result.remainingSize).toBe(1.25);
  });

  test("matching menolak ukuran non-positif tanpa peduli kontrak", () => {
    expect(() => planLevelConsumption(0, [{ price: "100", size: 1 }])).toThrow();
    expect(() => planLevelConsumption(-1, [{ price: "100", size: 1 }])).toThrow();
  });
});

describe("Phase 11.5 — posisi pecahan", () => {
  const position = (size: number, entryPrice = "3000", margin = "375") => ({
    direction: "long" as const,
    size,
    entryPrice,
    initialMargin: margin,
    leverage: "10",
  });

  test("open → reduce → close tetap eksak", () => {
    const opened = planPositionTransition({
      spec: ETH_USDT, existing: null, fillSide: "buy", fillSize: 1.25, fillPrice: "3000", leverage: "10",
    });
    expect(opened.kind).toBe("open");
    expect(opened.result!.size).toBe(1.25);

    const reduced = planPositionTransition({
      spec: ETH_USDT, existing: position(1.25), fillSide: "sell", fillSize: 0.5, fillPrice: "3100", leverage: "10",
    });
    expect(reduced.kind).toBe("reduce");
    expect(reduced.closedSize).toBe(0.5);
    expect(reduced.result!.size).toBe(0.75);

    const closed = planPositionTransition({
      spec: ETH_USDT, existing: position(0.75), fillSide: "sell", fillSize: 0.75, fillPrice: "3200", leverage: "10",
    });
    expect(closed.kind).toBe("close");
    expect(closed.closesOldPosition).toBe(true);
    expect(closed.result).toBeNull();
  });

  test("increase pecahan tidak melayang", () => {
    const increased = planPositionTransition({
      spec: ETH_USDT, existing: position(1.25), fillSide: "buy", fillSize: 0.5, fillPrice: "3100", leverage: "10",
    });
    expect(increased.kind).toBe("increase");
    expect(increased.result!.size).toBe(1.75);
  });

  test("reduce_only membatasi pada ukuran posisi pecahan", () => {
    const limited = reduceOnlySize({
      spec: ETH_USDT, existing: position(0.75), fillSide: "sell", requestedSize: 2,
    });
    expect(limited).toBe(0.75);
    // Searah posisi = bukan pengurangan.
    expect(reduceOnlySize({ spec: ETH_USDT, existing: position(0.75), fillSide: "buy", requestedSize: 1 })).toBe(0);
  });

  test("tidak ada drift float pada rangkaian pengurangan 0.3 − 0.1 − 0.1 − 0.1", () => {
    const reduce = (size: number) =>
      planPositionTransition({
        spec: ETH_USDT, existing: position(size), fillSide: "sell", fillSize: 0.1, fillPrice: "3000", leverage: "10",
      });
    const first = reduce(0.3);
    expect(first.result!.size).toBe(0.2);
    const second = reduce(first.result!.size);
    expect(second.result!.size).toBe(0.1);
    const third = reduce(second.result!.size);
    // Langkah ketiga menutup posisi penuh — bukan 2.7e-17 sisa.
    expect(third.kind).toBe("close");
    expect(third.result).toBeNull();
  });
});

describe("Phase 11.5 — ekonomi pecahan (PnL, fee, margin)", () => {
  test("PnL, fee, dan margin eksak untuk 1.25 kontrak", () => {
    const size = 1.25;
    const entry = "3000";
    const exit = "3200";
    const changed = planPositionTransition({
      spec: ETH_USDT, existing: { direction: "long", size, entryPrice: entry, initialMargin: "375", leverage: "10" },
      fillSide: "sell", fillSize: size, fillPrice: exit, leverage: "10",
    });
    // ETH_USDT: multiplier 0.01 → base qty 0.0125 ETH → PnL = 0.0125 × 200 = 2.5
    expect(changed.realizedPnl.toString()).toBe("2.5");
    expect(changed.closedSize).toBe(1.25);
  });

  test("margin awal = notional / leverage", () => {
    const opened = planPositionTransition({
      spec: ETH_USDT, existing: null, fillSide: "buy", fillSize: 1.25, fillPrice: "3000", leverage: "10",
    });
    // notional = 1.25 × 0.01 × 3000 = 37.5 → margin = 3.75
    expect(opened.openedMargin.toString()).toBe("3.75");
  });
});

describe("Phase 11.5 — API PAPER menerima ukuran desimal", () => {
  const harnesses: ApiHarness[] = [];
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  async function setupReady(): Promise<{ h: ApiHarness; accountId: string }> {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "ETH_USDT", "3000");
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h, { initialBalance: "10000" });
    return { h, accountId };
  }

  async function submit(
    h: ApiHarness,
    accountId: string,
    contract: string,
    size: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    return h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: `cmd-${contract}-${size}`,
      contract,
      side: "buy",
      type: "market",
      size,
      leverage: "10",
    });
  }

  test("kontrak desimal: size string desimal diterima dan posisinya eksak", async () => {
    const { h, accountId } = await setupReady();
    const result = await submit(h, accountId, "ETH_USDT", "1.25");
    expect(result.status).toBeLessThan(400);

    const positions = new PositionRepository(h.connection).listOpen(accountId);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.size).toBe(1.25);
    const fills = new FillRepository(h.connection).listByAccount(accountId);
    expect(fills[0]!.size).toBe(1.25);
  });

  test("kontrak integer: size desimal ditolak dan tidak ada posisi", async () => {
    const { h, accountId } = await setupReady();
    const result = await submit(h, accountId, "BTC_USDT", "1.5");
    // Penolakan terekam sebagai order `rejected` (audit), bukan error HTTP.
    const order = result.json.order as { status: string; rejectReason: string | null };
    expect(order.status).toBe("rejected");
    expect(order.rejectReason).toContain("integer");
    expect(new PositionRepository(h.connection).listOpen(accountId)).toHaveLength(0);
  });

  test("kontrak integer: size bulat tetap diterima", async () => {
    const { h, accountId } = await setupReady();
    const result = await submit(h, accountId, "BTC_USDT", "125");
    expect((result.json.order as { status: string }).status).toBe("filled");
    expect(new PositionRepository(h.connection).listOpen(accountId)[0]!.size).toBe(125);
  });

  test("DTO tetap string: size numerik JSON tidak diterima", async () => {
    const { h, accountId } = await setupReady();
    const result = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "cmd-numeric", contract: "ETH_USDT", side: "buy", type: "market", size: 1.25, leverage: "10",
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Phase 11.5 — eksekusi otonom & replay desimal", () => {
  function decimalDecision(overrides: { size: number; signal?: "long" | "short" }): ReturnType<typeof decide> {
    const signal = overrides.signal ?? "long";
    const features = snapshot({
      contract: "ETH_USDT", close: "3000", atr14: "15", trendStructure: "bullish",
    });
    const base = decide({
      contract: "ETH_USDT", timeframe: "5m", candleCloseTimeMs: T0, accountId: "acct-dec",
      features,
      scanner: scannerResult({ contract: "ETH_USDT", signal }),
      spec: ETH_USDT,
      market: market({ bestBid: "2999", bestAsk: "3000" }),
      account: account(),
      policy: DEFAULT_RISK_POLICY,
    });
    return { ...base, tradePlan: { ...base.tradePlan!, size: overrides.size } };
  }

  test("TradePlan berukuran pecahan dieksekusi (bukan SIZE_NOT_EXECUTABLE)", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setup(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const outcome = execution.executeApprovedDecision({
      decision: decimalDecision({ size: 1.25 }),
      spec: ETH_USDT,
      book: book("ETH_USDT", "2999", "3000"),
      nowMs: T0,
    });
    expect(outcome!.status).toBe("filled");
    expect(outcome!.errorCode).toBeNull();
    const positions = new PositionRepository(db.connection).listOpen(accountId);
    expect(positions[0]!.size).toBe(1.25);
  });

  test("SIZE_NOT_EXECUTABLE hanya untuk ukuran tidak sah", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setup(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    for (const size of [0, -1]) {
      const outcome = execution.executeApprovedDecision({
        decision: decimalDecision({ size }),
        spec: ETH_USDT,
        book: book("ETH_USDT", "2999", "3000"),
        nowMs: T0,
      });
      expect(outcome!.status).toBe("skipped");
      expect(outcome!.errorCode).toBe("SIZE_NOT_EXECUTABLE");
    }
  });

  test("ukuran pecahan yang melanggar aturan kontrak ditolak OrderService", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setup(db);
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    // BTC_USDT enable_decimal=false → 1.5 harus ditolak oleh OrderService.
    const features = snapshot({ contract: "BTC_USDT", atr14: "400" });
    const base = decide({
      contract: "BTC_USDT", timeframe: "5m", candleCloseTimeMs: T0, accountId,
      features, scanner: scannerResult({ signal: "long" }), spec: BTC_USDT,
      market: market({ bestAsk: "80000", bestBid: "79995" }), account: account(), policy: DEFAULT_RISK_POLICY,
    });
    const outcome = execution.executeApprovedDecision({
      decision: { ...base, tradePlan: { ...base.tradePlan!, size: 1.5 } },
      spec: BTC_USDT,
      book: book("BTC_USDT", "79995", "80000"),
      nowMs: T0,
    });
    expect(outcome!.status).toBe("rejected");
    expect(outcome!.errorCode).toBe("ORDER_REJECTED");
    expect(new PositionRepository(db.connection).listOpen(accountId)).toHaveLength(0);
  });

  test("replay otonom mengeksekusi kontrak desimal lewat OrderService yang sama", () => {
    const db = openTempDatabase();
    dbs.push(db);
    const accountId = setup(db, [ETH_USDT]);
    const recorder = new MarketRecorder({
      sessions: new RecordingSessionRepository(db.connection, () => "sess-dec"),
      observations: new MarketObservationRepository(db.connection),
    });
    const sessionId = recorder.startSession({ source: "live", contracts: ["ETH_USDT"], startedAtMs: T0 });
    for (const candle of bullishSetupCandles("ETH_USDT", 260)) {
      const at = candle.openTimeSeconds * 1000;
      const price = Number(candle.c);
      recorder.record(sessionId, {
        kind: "quote", contract: "ETH_USDT", sourceTimestampMs: at, observedAtMs: at,
        bestBid: (price * 0.9995).toFixed(6), bestBidSize: 9000,
        bestAsk: (price * 1.0005).toFixed(6), bestAskSize: 9000,
      }, at);
      recorder.record(sessionId, {
        kind: "mark", contract: "ETH_USDT", sourceTimestampMs: at, observedAtMs: at,
        markPrice: String(price), lastPrice: String(price), indexPrice: String(price),
      }, at + 1);
      recorder.record(sessionId, {
        kind: "candle", contract: "ETH_USDT", sourceTimestampMs: at, observedAtMs: at,
        interval: candle.interval, openTimeSeconds: candle.openTimeSeconds, open: candle.o,
        high: candle.h, low: candle.l, close: candle.c, volume: candle.v, closed: true,
      }, at + 2);
    }
    recorder.stopSession(T0 + 100 * 24 * 3600_000);

    const clock = virtualClock(T0);
    const analytics = new AnalyticsService({ connection: db.connection, clock, persist: true });
    const decisions = new DecisionService({ connection: db.connection, clock, persist: true });
    const tracker = new AutonomousTradeTracker({ connection: db.connection, clock });
    const execution = new TradeExecutionService({ connection: db.connection, accountId, enabled: true });
    const service = new ReplayService({ target: db.connection, analytics, decisions, execution, tracker });
    const result = service.run({ sessionId, accountId });

    const execCounters = result.autonomous!.execution;
    expect(execCounters.executionFilled).toBeGreaterThan(0);
    // Tidak ada lagi penolakan SIZE_NOT_EXECUTABLE massal.
    const statuses = new DecisionExecutionRepository(db.connection).list();
    const sizeRejected = statuses.filter((row) => row.errorCode === "SIZE_NOT_EXECUTABLE");
    expect(sizeRejected).toHaveLength(0);

    const positions = new PositionRepository(db.connection).listOpen(accountId);
    const all = new PositionRepository(db.connection).listByAccount(accountId);
    expect(all.length).toBeGreaterThan(0);
    for (const position of all) {
      expect(Number.isInteger(position.size)).toBe(false);
    }
    void positions;
  });
});
