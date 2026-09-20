import { afterEach, describe, expect, test } from "bun:test";
import { Decimal, parseMarkSnapshot, type MarkSnapshot } from "../packages/core/src/index.js";
import { MarkToMarketService } from "../apps/server/src/services/mark-to-market-service.js";
import { book, intent, setupExchange, type ExchangeHarness } from "./helpers/exchange.js";
import { BTC_USDT, ETH_USDT, SOL_USDT } from "./helpers/fixtures.js";

const harnesses: ExchangeHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

/**
 * 21. SKENARIO RUNTIME DETERMINISTIK
 *
 * PRNG ber-seed tetap; tidak ada Math.random() maupun Date.now(). Campuran:
 * buka posisi (Phase 3), mark naik/turun, TP, SL, gap, likuidasi, funding pada
 * beberapa timestamp, tick duplikat, dan beberapa posisi sekaligus.
 */

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const pick = <T,>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const randInt = (rng: () => number, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

const BASE_PRICE: Record<string, string> = {
  BTC_USDT: "80000",
  ETH_USDT: "3000",
  SOL_USDT: "150",
};

interface ScenarioResult {
  readonly steps: number;
  readonly closes: number;
  readonly fundingApplications: number;
  readonly liquidationCloses: number;
  readonly tpCloses: number;
  readonly slCloses: number;
  readonly duplicateTicks: number;
  readonly digest: string;
  readonly balances: {
    wallet: string;
    used: string;
    reserved: string;
    fees: string;
    fundingPaid: string;
    realized: string;
  };
  readonly counts: { fills: number; positions: number; openPositions: number; ledger: number };
}

function runScenario(seed: number, steps: number): ScenarioResult {
  const h: ExchangeHarness = setupExchange({
    initialBalance: "1000000",
    specs: [BTC_USDT, ETH_USDT, SOL_USDT],
    startMs: 1_700_000_000_000,
  });
  harnesses.push(h);
  const m2m = new MarkToMarketService({
    connection: h.connection,
    fillIdFactory: (() => {
      let n = 0;
      return () => `sf${String((n += 1)).padStart(6, "0")}`;
    })(),
  });
  const rng = makeRng(seed);

  let closes = 0;
  let liquidationCloses = 0;
  let tpCloses = 0;
  let slCloses = 0;
  let fundingApplications = 0;
  let duplicateTicks = 0;
  let fundingTs = h.now() + 50;

  for (let i = 0; i < steps; i += 1) {
    const contract = pick(rng, ["BTC_USDT", "ETH_USDT", "SOL_USDT"]);
    const base = new Decimal(BASE_PRICE[contract]!);
    const roll = rng();

    // Pergerakan mark deterministik, kadang berupa gap besar.
    const isGap = rng() < 0.12;
    const bps = isGap ? randInt(rng, -900, 900) : randInt(rng, -150, 150);
    const markPrice = base.times(new Decimal(1).plus(new Decimal(bps).div(10000))).toDecimalPlaces(2).toFixed();
    const execPrice = new Decimal(markPrice).times("0.9995").toDecimalPlaces(2).toFixed();

    if (roll < 0.3) {
      // Buka / tambah posisi dengan TP/SL kadang dipasang.
      const side = rng() < 0.5 ? "buy" : "sell";
      const size = randInt(rng, 1, 6);
      const withTp = rng() < 0.4;
      const withSl = rng() < 0.4;
      const entry = new Decimal(BASE_PRICE[contract]!);
      try {
        h.service.submitOrder({
          commandId: `open-${i}`,
          accountId: h.accountId,
          intent: intent({
            contract,
            side,
            size,
            type: "market",
            tpPrice: withTp ? entry.times("1.03").toDecimalPlaces(2).toFixed() : null,
            slPrice: withSl ? entry.times("0.97").toDecimalPlaces(2).toFixed() : null,
          }),
          book: book(contract, [[BASE_PRICE[contract]!, 5000]], [[BASE_PRICE[contract]!, 5000]]),
          nowMs: h.advance(),
        });
      } catch {
        // ditolak (mis. margin tidak cukup) — diabaikan
      }
    } else if (roll < 0.36) {
      // Tick duplikat: commandId dan waktu sama, diproses dua kali.
      duplicateTicks += 1;
      const nowMs = h.advance();
      const mark: MarkSnapshot = parseMarkSnapshot({
        contract,
        markPrice,
        observedAtMs: nowMs,
        sourceTimestampMs: nowMs,
        funding: null,
      });
      const execution = { contract, bidPrice: execPrice, askPrice: execPrice };
      const result = m2m.processMark({ commandId: `dup-${i}`, accountId: h.accountId, mark, execution, nowMs });
      m2m.processMark({ commandId: `dup-${i}`, accountId: h.accountId, mark, execution, nowMs });
      closes += result.actions.length;
      for (const action of result.actions) {
        if (action.reason === "liquidation") liquidationCloses += 1;
        if (action.reason === "take_profit") tpCloses += 1;
        if (action.reason === "stop_loss") slCloses += 1;
      }
    } else {
      // Proses mark (kadang membawa observasi funding, kadang timestamp lama).
      const reuseFunding = rng() < 0.25;
      if (!reuseFunding) {
        fundingTs = h.now() + randInt(rng, 1, 20);
      }
      const withFunding = rng() < 0.7;
      const nowMs = h.advance(randInt(rng, 1, 30));
      const mark: MarkSnapshot = parseMarkSnapshot({
        contract,
        markPrice,
        observedAtMs: nowMs,
        sourceTimestampMs: nowMs,
        funding: withFunding
          ? {
              fundingRate: pick(rng, ["0.0001", "-0.0001", "0.00005", "-0.000075"]),
              fundingTimestampMs: fundingTs,
              intervalSeconds: 28800,
            }
          : null,
      });
      const result = m2m.processMark({
        commandId: `mark-${i}`,
        accountId: h.accountId,
        mark,
        execution: { contract, bidPrice: execPrice, askPrice: execPrice },
        nowMs,
      });
      closes += result.actions.length;
      fundingApplications += result.funding.filter((entry) => entry.applied).length;
      for (const action of result.actions) {
        if (action.reason === "liquidation") liquidationCloses += 1;
        if (action.reason === "take_profit") tpCloses += 1;
        if (action.reason === "stop_loss") slCloses += 1;
      }
    }

    if (i % 100 === 0) {
      assertRuntimeInvariants(h, m2m);
    }
  }

  assertRuntimeInvariants(h, m2m);

  const balances = h.balances();
  return {
    steps,
    closes,
    fundingApplications,
    liquidationCloses,
    tpCloses,
    slCloses,
    duplicateTicks,
    digest: digestOf(h),
    balances: {
      wallet: balances.walletBalance.toString(),
      used: balances.usedMargin.toString(),
      reserved: balances.reservedMargin.toString(),
      fees: balances.feesPaid.toString(),
      fundingPaid: balances.fundingPaid.toString(),
      realized: balances.realizedPnl.toString(),
    },
    counts: {
      fills: h.fills.count(),
      positions: h.positions.count(),
      openPositions: h.positions.listOpen(h.accountId).length,
      ledger: h.ledger.list(h.accountId, { limit: 100_000 }).length,
    },
  };
}

function digestOf(h: ExchangeHarness): string {
  const ledger = h.ledger
    .list(h.accountId, { limit: 100_000 })
    .map((entry) => `${entry.type}|${entry.amount.toString()}|${entry.marginDelta.toString()}|${entry.reservedDelta.toString()}|${entry.balanceAfter.toString()}`)
    .join(";");
  const fills = h.connection.sqlite
    .query("SELECT id, size, price, fee, realized_pnl, is_liquidation, is_tp_sl FROM fills ORDER BY id")
    .all() as Array<Record<string, unknown>>;
  const positions = h.connection.sqlite
    .query("SELECT id, direction, status, size, entry_price, initial_margin, realized_pnl, close_reason FROM positions ORDER BY id")
    .all() as Array<Record<string, unknown>>;
  return JSON.stringify({
    ledger,
    fills: fills.map((f) => `${String(f.id)}|${String(f.size)}|${String(f.price)}|${String(f.fee)}|${String(f.realized_pnl)}|${String(f.is_liquidation)}|${String(f.is_tp_sl)}`),
    positions: positions.map((p) => `${String(p.id)}|${String(p.direction)}|${String(p.status)}|${String(p.size)}|${String(p.entry_price)}|${String(p.initial_margin)}|${String(p.realized_pnl)}|${String(p.close_reason)}`),
  });
}

function assertRuntimeInvariants(h: ExchangeHarness, m2m: MarkToMarketService): void {
  const accountId = h.accountId;
  const balances = h.balances();
  const problems: string[] = [];

  // Kas tidak pernah negatif (defisit diampuni, bukan dibiarkan).
  if (balances.walletBalance.isNegative()) problems.push(`wallet negatif: ${balances.walletBalance.toString()}`);
  if (balances.usedMargin.isNegative()) problems.push("used_margin negatif");
  if (balances.reservedMargin.isNegative()) problems.push("reserved_margin negatif");
  if (h.available().isNegative()) problems.push("available negatif");

  // Posisi.
  const positionRows = h.connection.sqlite
    .query("SELECT size, initial_margin, status FROM positions WHERE account_id = ?")
    .all(accountId) as Array<{ size: number; initial_margin: string; status: string }>;
  for (const row of positionRows) {
    if (row.size < 0) problems.push(`ukuran posisi negatif: ${row.size}`);
    if (new Decimal(row.initial_margin).isNegative()) problems.push("margin posisi negatif");
    if (row.status !== "open" && row.size !== 0) problems.push(`posisi ${row.status} bersisa ${row.size}`);
  }

  // used_margin == Σ margin posisi open.
  if (!h.positions.totalOpenMargin(accountId).eq(balances.usedMargin)) {
    problems.push("used_margin != Σ margin posisi open");
  }

  // Σ fill size == orders.filled_size; reservasi order final nol.
  const orderRows = h.connection.sqlite
    .query(
      `SELECT o.id, o.size, o.filled_size, o.status, o.reserved_margin,
              COALESCE((SELECT SUM(f.size) FROM fills f WHERE f.order_id = o.id), 0) AS fill_total
         FROM orders o WHERE o.account_id = ?`,
    )
    .all(accountId) as Array<{ id: string; size: number; filled_size: number; status: string; reserved_margin: string | null; fill_total: number }>;
  for (const row of orderRows) {
    if (row.fill_total !== row.filled_size) problems.push(`order ${row.id}: Σfill != filled`);
    if (row.filled_size > row.size) problems.push(`order ${row.id}: filled > size`);
    if (
      (row.status === "filled" || row.status === "cancelled" || row.status === "rejected") &&
      !new Decimal(row.reserved_margin ?? "0").isZero()
    ) {
      problems.push(`order ${row.id} status ${row.status} menahan reservasi`);
    }
  }

  // Fill penutupan paksa harus punya order_id NULL dan flag yang konsisten.
  const forcedFills = h.connection.sqlite
    .query("SELECT id, order_id, is_liquidation, is_tp_sl FROM fills WHERE is_liquidation = 1 OR is_tp_sl = 1")
    .all() as Array<{ id: string; order_id: string | null; is_liquidation: number; is_tp_sl: number }>;
  for (const fill of forcedFills) {
    if (fill.order_id !== null) problems.push(`fill paksa ${fill.id} punya order_id`);
    if (fill.is_liquidation === 1 && fill.is_tp_sl === 1) problems.push(`fill ${fill.id} ditandai likuidasi dan TP/SL sekaligus`);
  }

  // Funding: satu entri per (contract, timestamp, posisi).
  const fundingKeys = h.connection.sqlite
    .query("SELECT idempotency_key FROM ledger WHERE type = 'funding'")
    .all() as Array<{ idempotency_key: string }>;
  const uniqueKeys = new Set(fundingKeys.map((row) => row.idempotency_key));
  if (uniqueKeys.size !== fundingKeys.length) problems.push("ada funding ganda");

  // Rekonsiliasi cache saldo dengan ledger.
  const verified = h.ledger.verifyBalances(accountId);
  if (verified.chainMismatch !== null) problems.push("rantai balance_after tidak konsisten");
  if (!verified.cacheMatches) problems.push("cache saldo tidak cocok dengan ledger");

  // Identitas valuasi: equity == wallet + Σ upnl pada mark sehat.
  const marks = new Map<string, string>([
    ["BTC_USDT", BASE_PRICE.BTC_USDT!],
    ["ETH_USDT", BASE_PRICE.ETH_USDT!],
    ["SOL_USDT", BASE_PRICE.SOL_USDT!],
  ]);
  const evaluated = m2m.evaluateAccount({ accountId, marks });
  const sumUpnl = evaluated.valuations.reduce((sum, v) => sum.plus(v.unrealizedPnl), new Decimal(0));
  if (!evaluated.account.equity.eq(balances.walletBalance.plus(sumUpnl))) {
    problems.push("equity != wallet + Σ upnl");
  }
  if (!evaluated.account.usedMargin.eq(balances.usedMargin)) {
    problems.push("valuasi usedMargin != cache");
  }

  expect(problems).toEqual([]);
}

describe("21. skenario runtime deterministik", () => {
  test("1500 langkah runtime menjaga seluruh invariant", () => {
    const result = runScenario(20260921, 1500);
    expect(result.steps).toBe(1500);
    // Skenario harus benar-benar mengeksekusi ekonomi, bukan no-op.
    expect(result.counts.fills).toBeGreaterThan(50);
    expect(result.closes).toBeGreaterThan(10);
    expect(result.fundingApplications).toBeGreaterThan(3);
    // Berbagai jalur penutupan terpicu.
    expect(result.liquidationCloses + result.tpCloses + result.slCloses).toBeGreaterThan(10);
    expect(result.duplicateTicks).toBeGreaterThan(0);
  }, 180_000);

  test("reproducible byte-per-byte dengan seed yang sama", () => {
    const first = runScenario(777, 400);
    const second = runScenario(777, 400);
    expect(second.digest).toBe(first.digest);
    expect(second.balances).toEqual(first.balances);
    expect(second.counts).toEqual(first.counts);
    expect(second.fundingApplications).toBe(first.fundingApplications);
  }, 120_000);

  test("seed berbeda menghasilkan jalur ekonomi berbeda", () => {
    const a = runScenario(11, 300);
    const b = runScenario(12, 300);
    expect(a.digest).not.toBe(b.digest);
  }, 120_000);

  test("skenario penuh menutup posisi dan merekonsiliasi ledger", () => {
    const result = runScenario(999, 600);
    // Setelah banyak aksi risiko, setidaknya ada posisi yang tertutup.
    expect(result.counts.positions).toBeGreaterThan(result.counts.openPositions);
    // Saldo akhir non-negatif.
    expect(new Decimal(result.balances.wallet).isNegative()).toBe(false);
    expect(new Decimal(result.balances.used).isNegative()).toBe(false);
  }, 120_000);
});
