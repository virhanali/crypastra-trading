import { afterEach, describe, expect, test } from "bun:test";
import { Decimal } from "../packages/core/src/index.js";
import { btcBook, book, intent, setupExchange, type ExchangeHarness } from "./helpers/exchange.js";
import { BTC_USDT, ETH_USDT, SOL_USDT } from "./helpers/fixtures.js";

const harnesses: ExchangeHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

/**
 * 20. SKENARIO DETERMINISTIK 1000+ OPERASI
 *
 * PRNG deterministik (LCG) dengan seed tetap. Tidak ada Math.random(). Urutan
 * operasi, buku, dan keputusan sepenuhnya dapat direproduksi.
 */

/** Linear congruential generator deterministik (numerik non-finansial). */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[index]!;
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const CONTRACTS: Record<string, { price: string }> = {
  BTC_USDT: { price: "80000" },
  ETH_USDT: { price: "3000" },
  SOL_USDT: { price: "150" },
};

function priceGrid(contract: string, rng: () => number): string {
  const base = new Decimal(CONTRACTS[contract]!.price);
  // Pergerakan deterministik ±2%.
  const deltaBps = randInt(rng, -200, 200);
  return base.times(new Decimal(1).plus(new Decimal(deltaBps).div(10000))).toDecimalPlaces(2).toFixed();
}

function makeBook(contract: string, rng: () => number): ReturnType<typeof book> {
  const mid = new Decimal(priceGrid(contract, rng));
  const depth = randInt(rng, 1, 40);
  const bids: Array<[string, number]> = [
    [mid.times("0.999").toDecimalPlaces(2).toFixed(), depth],
    [mid.times("0.998").toDecimalPlaces(2).toFixed(), depth],
    [mid.times("0.997").toDecimalPlaces(2).toFixed(), depth],
  ];
  const asks: Array<[string, number]> = [
    [mid.times("1.001").toDecimalPlaces(2).toFixed(), depth],
    [mid.times("1.002").toDecimalPlaces(2).toFixed(), depth],
    [mid.times("1.003").toDecimalPlaces(2).toFixed(), depth],
  ];
  return book(contract, bids, asks);
}

interface ScenarioResult {
  readonly operations: number;
  readonly digest: string;
  readonly balances: {
    wallet: string;
    used: string;
    reserved: string;
    fees: string;
    realized: string;
  };
  readonly counts: { orders: number; fills: number; positions: number; openPositions: number; ledger: number };
}

function runScenario(seed: number, operationCount: number): ScenarioResult {
  const h = setupExchange({ initialBalance: "100000", specs: [BTC_USDT, ETH_USDT, SOL_USDT], startMs: 1_700_000_000_000 });
  try {
    const rng = makeRng(seed);
    let operations = 0;
    const liveOrders: string[] = [];
    let rejections = 0;

    for (let i = 0; i < operationCount; i += 1) {
      const contract = pick(rng, ["BTC_USDT", "ETH_USDT", "SOL_USDT"]);
      const spec = h.contracts.require(contract);
      const roll = rng();
      const commandId = `op-${i}`;
      operations += 1;

      try {
        if (roll < 0.4) {
          // Market open/increase/reduce/flip
          const side = rng() < 0.5 ? "buy" : "sell";
          const size = randInt(rng, 1, Math.min(10, spec.orderSizeMax));
          const result = h.service.submitOrder({
            commandId,
            accountId: h.accountId,
            intent: intent({ contract, side, size, type: "market" }),
            book: makeBook(contract, rng),
            nowMs: h.advance(),
          });
          if (result.order.status === "rejected") {
            rejections += 1;
          }
        } else if (roll < 0.6) {
          // Limit resting
          const mid = new Decimal(CONTRACTS[contract]!.price);
          const side = rng() < 0.5 ? "buy" : "sell";
          const price = side === "buy"
            ? mid.times("0.98").toDecimalPlaces(2).toFixed()
            : mid.times("1.02").toDecimalPlaces(2).toFixed();
          const size = randInt(rng, 1, Math.min(8, spec.orderSizeMax));
          const result = h.service.submitOrder({
            commandId,
            accountId: h.accountId,
            intent: intent({ contract, side, size, type: "limit", price, timeInForce: "gtc" }),
            book: makeBook(contract, rng),
            nowMs: h.advance(),
          });
          if (result.order.status === "open" || result.order.status === "partially_filled") {
            liveOrders.push(result.order.id);
          }
        } else if (roll < 0.8) {
          // Evaluasi order resting terhadap snapshot baru
          const target = liveOrders.filter((id) => {
            const stored = h.orders.find(id);
            return stored !== null && (stored.status === "open" || stored.status === "partially_filled");
          });
          if (target.length > 0) {
            const orderId = pick(rng, target);
            const stored = h.orders.require(orderId);
            h.service.evaluateOrder({
              commandId,
              orderId,
              book: makeBook(stored.contract, rng),
              nowMs: h.advance(),
            });
          }
        } else if (roll < 0.9) {
          // Cancel
          const target = liveOrders.filter((id) => {
            const stored = h.orders.find(id);
            return stored !== null && (stored.status === "open" || stored.status === "partially_filled");
          });
          if (target.length > 0) {
            h.service.cancelOrder({ commandId, orderId: pick(rng, target), nowMs: h.advance() });
          }
        } else {
          // Upaya saldo tidak cukup (harus ditolak tanpa efek ekonomi)
          const result = h.service.submitOrder({
            commandId,
            accountId: h.accountId,
            intent: intent({ contract, side: rng() < 0.5 ? "buy" : "sell", size: spec.orderSizeMax, type: "market" }),
            book: makeBook(contract, rng),
            nowMs: h.advance(),
          });
          if (result.order.status === "rejected") {
            rejections += 1;
          }
        }
      } catch {
        // Order yang tidak bisa dievaluasi/dibatalkan (mis. sudah final) diabaikan;
        // pemanggil harus tetap dapat melanjutkan skenario.
        operations -= 1;
      }

      // Buang order yang sudah tidak hidup supaya daftar tetap kecil.
      for (let k = liveOrders.length - 1; k >= 0; k -= 1) {
        const stored = h.orders.find(liveOrders[k]!);
        if (stored === null || (stored.status !== "open" && stored.status !== "partially_filled")) {
          liveOrders.splice(k, 1);
        }
      }

      // Integritas murah sering, rekonsiliasi penuh berkala.
      if (i % 100 === 0) {
        assertCoreInvariants(h);
      }
      if (i % 400 === 0) {
        assertFullIntegrity(h);
      }
    }

    assertFullIntegrity(h);

    const balances = h.balances();
    return {
      operations,
      digest: digestOf(h),
      balances: {
        wallet: balances.walletBalance.toString(),
        used: balances.usedMargin.toString(),
        reserved: balances.reservedMargin.toString(),
        fees: balances.feesPaid.toString(),
        realized: balances.realizedPnl.toString(),
      },
      counts: {
        orders: h.orders.count(),
        fills: h.fills.count(),
        positions: h.positions.count(),
        openPositions: h.positions.listOpen(h.accountId).length,
        ledger: h.ledger.list(h.accountId, { limit: 100_000 }).length,
      },
    };
  } finally {
    h.cleanup();
  }
}

/** Ringkasan deterministik dari seluruh efek ekonomi. */
function digestOf(h: ExchangeHarness): string {
  const ledger = h.ledger
    .list(h.accountId, { limit: 100_000 })
    .map((entry) => `${entry.type}|${entry.amount.toString()}|${entry.marginDelta.toString()}|${entry.reservedDelta.toString()}|${entry.balanceAfter.toString()}`)
    .join(";");
  const fills = h.connection.sqlite
    .query("SELECT id, size, price, fee, realized_pnl FROM fills ORDER BY id")
    .all() as Array<{ id: string; size: number; price: string; fee: string; realized_pnl: string }>;
  const positions = h.connection.sqlite
    .query("SELECT id, direction, status, size, entry_price, initial_margin, realized_pnl FROM positions ORDER BY id")
    .all() as Array<Record<string, unknown>>;
  return JSON.stringify({
    ledger,
    fills: fills.map((fill) => `${fill.id}|${fill.size}|${fill.price}|${fill.fee}|${fill.realized_pnl}`),
    positions: positions.map((p) => `${String(p.id)}|${String(p.direction)}|${String(p.status)}|${String(p.size)}|${String(p.entry_price)}|${String(p.initial_margin)}|${String(p.realized_pnl)}`),
  });
}

/** Invariant murah (agregat SQL). Assertion dikumpulkan agar tidak O(n) expect. */
function assertCoreInvariants(h: ExchangeHarness): void {
  const accountId = h.accountId;
  const balances = h.balances();

  const problems: string[] = [];

  if (balances.usedMargin.isNegative()) problems.push("used_margin negatif");
  if (balances.reservedMargin.isNegative()) problems.push("reserved_margin negatif");
  if (h.available().isNegative()) problems.push("available negatif");

  const positionRows = h.connection.sqlite
    .query("SELECT size, initial_margin, status FROM positions WHERE account_id = ?")
    .all(accountId) as Array<{ size: number; initial_margin: string; status: string }>;
  for (const row of positionRows) {
    if (row.size < 0) problems.push(`ukuran posisi negatif: ${row.size}`);
    if (new Decimal(row.initial_margin).isNegative()) problems.push(`margin posisi negatif: ${row.initial_margin}`);
    if (row.status !== "open" && row.size !== 0) problems.push(`posisi ${row.status} masih bersisa ${row.size}`);
  }

  const openMargin = h.connection.sqlite
    .query("SELECT COALESCE(SUM(CAST(initial_margin AS REAL)), 0) AS total FROM positions WHERE account_id = ? AND status = 'open'")
    .get(accountId) as { total: number };
  if (Math.abs(openMargin.total - Number(balances.usedMargin.toFixed(8))) > 1e-6) {
    problems.push(`used_margin ${balances.usedMargin.toString()} != Σ margin open ${openMargin.total}`);
  }

  const orderRows = h.connection.sqlite
    .query(
      `SELECT o.id, o.size, o.filled_size, o.status, o.reserved_margin,
              COALESCE((SELECT SUM(f.size) FROM fills f WHERE f.order_id = o.id), 0) AS fill_total
         FROM orders o WHERE o.account_id = ?`,
    )
    .all(accountId) as Array<{
    id: string;
    size: number;
    filled_size: number;
    status: string;
    reserved_margin: string | null;
    fill_total: number;
  }>;
  for (const row of orderRows) {
    if (row.fill_total !== row.filled_size) {
      problems.push(`order ${row.id}: Σfill ${row.fill_total} != filled ${row.filled_size}`);
    }
    if (row.filled_size > row.size) {
      problems.push(`order ${row.id}: filled ${row.filled_size} > size ${row.size}`);
    }
    if (row.status === "filled" && row.filled_size !== row.size) {
      problems.push(`order ${row.id}: filled tapi sisa ${row.size - row.filled_size}`);
    }
    if (
      (row.status === "filled" || row.status === "cancelled" || row.status === "rejected") &&
      !new Decimal(row.reserved_margin ?? "0").isZero()
    ) {
      problems.push(`order ${row.id}: status ${row.status} masih menahan reservasi ${row.reserved_margin}`);
    }
  }

  const liveReserved = h.connection.sqlite
    .query(
      `SELECT COALESCE(SUM(CAST(reserved_margin AS REAL)), 0) AS total
         FROM orders
        WHERE account_id = ? AND status IN ('open','partially_filled') AND type = 'limit'
          AND time_in_force IN ('gtc','post_only')`,
    )
    .get(accountId) as { total: number };
  if (Math.abs(liveReserved.total - Number(balances.reservedMargin.toFixed(8))) > 1e-6) {
    problems.push(`cache reserved ${balances.reservedMargin.toString()} != Σ reservasi live ${liveReserved.total}`);
  }

  expect(problems).toEqual([]);
}

/** Invariant mahal: rekonsiliasi cache dengan seluruh ledger. */
function assertFullIntegrity(h: ExchangeHarness): void {
  assertCoreInvariants(h);
  const verified = h.ledger.verifyBalances(h.accountId);
  expect(verified.chainMismatch).toBeNull();
  expect(verified.cacheMatches).toBe(true);
}

describe("20. skenario 1000+ operasi deterministik", () => {
  test("1200 operasi campuran menjaga seluruh invariant", () => {
    const result = runScenario(20260920, 1200);
    expect(result.operations).toBeGreaterThan(1000);
    // Skenario harus benar-benar mengeksekusi ekonomi, bukan no-op.
    expect(result.counts.fills).toBeGreaterThan(50);
    expect(result.counts.orders).toBeGreaterThan(50);
  }, 120_000);

  test("skenario reproducible byte-per-byte dengan seed yang sama", () => {
    const first = runScenario(424242, 300);
    const second = runScenario(424242, 300);
    expect(second.digest).toBe(first.digest);
    expect(second.balances).toEqual(first.balances);
    expect(second.counts).toEqual(first.counts);
  }, 60_000);

  test("seed berbeda menghasilkan jalur ekonomi berbeda", () => {
    const a = runScenario(1, 200);
    const b = runScenario(2, 200);
    // Digest berbeda membuktikan PRNG benar-benar memengaruhi jalannya skenario.
    expect(a.digest).not.toBe(b.digest);
  }, 60_000);

  test("tidak ada posisi berukuran negatif dan tidak ada saldo negatif di akhir", () => {
    const h = setupExchange({ initialBalance: "5000", specs: [BTC_USDT, ETH_USDT, SOL_USDT], startMs: 1 });
    harnesses.push(h);
    const rng = makeRng(7);
    for (let i = 0; i < 150; i += 1) {
      const contract = pick(rng, ["BTC_USDT", "ETH_USDT", "SOL_USDT"]);
      const size = randInt(rng, 1, 5);
      try {
        h.service.submitOrder({
          commandId: `x${i}`,
          accountId: h.accountId,
          intent: intent({ contract, side: rng() < 0.5 ? "buy" : "sell", size, type: "market" }),
          book: makeBook(contract, rng),
          nowMs: h.advance(),
        });
      } catch {
        // diabaikan
      }
      expect(h.available().greaterThanOrEqualTo(0)).toBe(true);
    }
    for (const position of h.positions.listOpen(h.accountId)) {
      expect(position.size).toBeGreaterThan(0);
    }
    expect(h.balances().walletBalance.isNegative()).toBe(false);
  }, 30_000);

  test("siklus penuh berulang tetap merekonsiliasi ledger", () => {
    const h = setupExchange({ initialBalance: "10000", specs: [BTC_USDT], startMs: 1 });
    harnesses.push(h);
    const rng = makeRng(99);
    for (let i = 0; i < 60; i += 1) {
      const mid = new Decimal(priceGrid("BTC_USDT", rng));
      const bids: Array<[string, number]> = [[mid.times("0.999").toDecimalPlaces(2).toFixed(), 50]];
      const asks: Array<[string, number]> = [[mid.times("1.001").toDecimalPlaces(2).toFixed(), 50]];
      h.service.submitOrder({
        commandId: `cycle${i}`,
        accountId: h.accountId,
        intent: intent({ contract: "BTC_USDT", side: rng() < 0.5 ? "buy" : "sell", size: randInt(rng, 1, 3), type: "market" }),
        book: book("BTC_USDT", bids, asks),
        nowMs: h.advance(),
      });
    }
    const rebuilt = h.ledger.rebuildBalances(h.accountId);
    expect(rebuilt.chainMismatch).toBeNull();
    const balances = h.balances();
    expect(rebuilt.balances.walletBalance.eq(balances.walletBalance)).toBe(true);
    expect(rebuilt.balances.usedMargin.eq(balances.usedMargin)).toBe(true);
    expect(rebuilt.balances.realizedPnl.eq(balances.realizedPnl)).toBe(true);
  }, 30_000);
});
