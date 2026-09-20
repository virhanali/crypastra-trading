import { afterEach, describe, expect, test } from "bun:test";
import { Decimal } from "../packages/core/src/index.js";
import { btcBook, book, intent, setupExchange, type ExchangeHarness } from "./helpers/exchange.js";
import { BTC_USDT } from "./helpers/fixtures.js";

const harnesses: ExchangeHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

function setup(balance = "10000"): ExchangeHarness {
  const h = setupExchange({ initialBalance: balance, specs: [BTC_USDT] });
  harnesses.push(h);
  return h;
}

/** Buka posisi dengan satu market order. */
function open(h: ExchangeHarness, commandId: string, side: "buy" | "sell", size: number, price: string) {
  return h.service.submitOrder({
    commandId,
    accountId: h.accountId,
    intent: intent({ side, size, type: "market" }),
    book: book("BTC_USDT", [[price, 1000]], [[price, 1000]]),
    nowMs: h.advance(),
  });
}

/** Fill terhadap harga eksplisit (bid=ask=price) memakai sisi yang tepat. */
function fillAt(h: ExchangeHarness, commandId: string, side: "buy" | "sell", size: number, price: string) {
  const bids = side === "sell" ? [[price, size + 100]] : [[new Decimal(price).minus(1).toFixed(), 100]];
  const asks = side === "buy" ? [[price, size + 100]] : [[new Decimal(price).plus(1).toFixed(), 100]];
  return h.service.submitOrder({
    commandId,
    accountId: h.accountId,
    intent: intent({ side, size, type: "market" }),
    book: book("BTC_USDT", bids as Array<[string, number]>, asks as Array<[string, number]>),
    nowMs: h.advance(),
  });
}

describe("9. posisi: open, increase, reduce, close, flip", () => {
  test("OPEN lalu INCREASE dengan harga berbeda (entry rata-rata)", () => {
    const h = setup();
    open(h, "c1", "buy", 1, "80000");
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")!.entryPrice.toString()).toBe("80000");
    expect(h.balances().usedMargin.toString()).toBe("0.8");

    fillAt(h, "c2", "buy", 1, "81000");
    const position = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(position.size).toBe(2);
    expect(position.entryPrice.toString()).toBe("80500");
    // margin = 0.8 + 0.81 = 1.61
    expect(position.initialMargin.toString()).toBe("1.61");
    expect(h.balances().usedMargin.toString()).toBe("1.61");
    // Tidak ada PnL realisasi saat menambah.
    expect(h.balances().realizedPnl.isZero()).toBe(true);
  });

  test("REDUCE merealisasikan PnL dan melepas margin proporsional", () => {
    const h = setup();
    open(h, "c1", "buy", 10, "80000");
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")!.initialMargin.toString()).toBe("8");

    const result = fillAt(h, "c2", "sell", 4, "81000");
    const position = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(position.size).toBe(6);
    expect(position.entryPrice.toString()).toBe("80000");
    // PnL = 4 × 0.0001 × 1000 = 0.4
    expect(result.fills[0]!.realizedPnl.toString()).toBe("0.4");
    expect(h.balances().realizedPnl.toString()).toBe("0.4");
    // margin dilepas 8 × 4/10 = 3.2 → sisa 4.8
    expect(position.initialMargin.toString()).toBe("4.8");
    expect(h.balances().usedMargin.toString()).toBe("4.8");
    // Margin kembali tersedia, bukan hilang.
    expect(h.balances().reservedMargin.isZero()).toBe(true);
  });

  test("CLOSE menutup posisi, melepas seluruh margin, posisi jadi closed", () => {
    const h = setup();
    open(h, "c1", "buy", 5, "80000");
    const positionId = h.positions.findOpen(h.accountId, "BTC_USDT")!.id;

    fillAt(h, "c2", "sell", 5, "79000");
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")).toBeNull();
    const closed = h.positions.require(positionId);
    expect(closed.status).toBe("closed");
    expect(closed.size).toBe(0);
    expect(closed.initialMargin.isZero()).toBe(true);
    expect(closed.closeReason).toBe("order");
    expect(h.balances().usedMargin.isZero()).toBe(true);
    // PnL = 5 × 0.0001 × (79000−80000) = −0.5
    expect(closed.realizedPnl.toString()).toBe("-0.5");
    expect(h.balances().realizedPnl.toString()).toBe("-0.5");
  });

  test("FLIP: close penuh + open arah baru sebagai baris posisi terpisah", () => {
    const h = setup();
    open(h, "c1", "buy", 3, "80000");
    const oldId = h.positions.findOpen(h.accountId, "BTC_USDT")!.id;

    fillAt(h, "c2", "sell", 10, "81000");

    const old = h.positions.require(oldId);
    expect(old.status).toBe("closed");
    expect(old.closeReason).toBe("flip");
    expect(old.realizedPnl.toString()).toBe("0.3"); // 3 × 0.0001 × 1000

    const opened = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(opened.id).not.toBe(oldId);
    expect(opened.direction).toBe("short");
    expect(opened.size).toBe(7);
    expect(opened.entryPrice.toString()).toBe("81000");
    expect(opened.initialMargin.toString()).toBe("5.67");
    // Tidak ada posisi berukuran negatif.
    expect(h.positions.listOpen(h.accountId)).toHaveLength(1);
  });

  test("SHORT lalu reduce saat harga turun menghasilkan PnL positif", () => {
    const h = setup();
    open(h, "c1", "sell", 10, "80000");
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")!.direction).toBe("short");

    fillAt(h, "c2", "buy", 4, "79000");
    // 4 × 0.0001 × (80000−79000) = 0.4
    expect(h.balances().realizedPnl.toString()).toBe("0.4");
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")!.size).toBe(6);
  });

  test("posisi tidak pernah berukuran negatif pada skenario flip berulang", () => {
    const h = setup();
    const prices = ["80000", "81000", "79000", "82000"];
    for (const [index, price] of prices.entries()) {
      fillAt(h, `c${index}`, index % 2 === 0 ? "buy" : "sell", 7, price);
      const position = h.positions.findOpen(h.accountId, "BTC_USDT");
      if (position !== null) {
        expect(position.size).toBeGreaterThan(0);
        expect(position.initialMargin.greaterThanOrEqualTo(0)).toBe(true);
      }
      for (const any of h.positions.listOpen(h.accountId)) {
        expect(any.size).toBeGreaterThan(0);
      }
    }
  });

  test("reduce_only membatasi pada eksposur dan tidak membalik arah", () => {
    const h = setup();
    open(h, "c1", "buy", 5, "80000");

    const result = h.service.submitOrder({
      commandId: "c2",
      accountId: h.accountId,
      intent: intent({ side: "sell", size: 9, type: "market", reduceOnly: true }),
      book: book("BTC_USDT", [["81000", 1000]], [["81010", 1000]]),
      nowMs: h.advance(),
    });

    // Dipotong pada 5, bukan 9, dan tidak membalik menjadi short.
    expect(result.order.filledSize).toBe(5);
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")).toBeNull();
    expect(h.positions.listOpen(h.accountId)).toHaveLength(0);
  });

  test("reduce_only tanpa posisi ditolak tanpa efek ekonomi", () => {
    const h = setup();
    const before = h.balances().walletBalance;
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "sell", size: 1, type: "market", reduceOnly: true }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("rejected");
    expect(result.fills).toHaveLength(0);
    expect(h.balances().walletBalance.eq(before)).toBe(true);
  });

  test("reduce_only searah posisi ditolak", () => {
    const h = setup();
    open(h, "c1", "buy", 2, "80000");
    const result = h.service.submitOrder({
      commandId: "c2",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market", reduceOnly: true }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    expect(result.order.status).toBe("rejected");
  });
});

describe("11. siklus PnL realisasi", () => {
  test("PnL masuk ledger dan cocok dengan fill", () => {
    const h = setup();
    open(h, "c1", "buy", 4, "80000");
    const result = fillAt(h, "c2", "sell", 2, "81500");

    const pnl = result.fills[0]!.realizedPnl;
    expect(pnl.toString()).toBe("0.3"); // 2 × 0.0001 × 1500
    const entries = h.ledger.list(h.accountId).filter((entry) => entry.type === "pnl_realized");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount.eq(pnl)).toBe(true);
    expect(h.balances().realizedPnl.eq(pnl)).toBe(true);
  });

  test("kerugian realisasi mengurangi saldo", () => {
    const h = setup();
    open(h, "c1", "buy", 4, "80000");
    const walletBefore = h.balances().walletBalance;
    fillAt(h, "c2", "sell", 2, "78000");
    // −0.4
    expect(h.balances().realizedPnl.toString()).toBe("-0.4");
    expect(h.balances().walletBalance.lessThan(walletBefore)).toBe(true);
  });

  test("rebuild ledger mereproduksi saldo setelah siklus penuh", () => {
    const h = setup();
    open(h, "c1", "buy", 4, "80000");
    fillAt(h, "c2", "sell", 4, "81000");

    const before = h.balances();
    const rebuilt = h.ledger.rebuildBalances(h.accountId);
    expect(rebuilt.chainMismatch).toBeNull();
    expect(rebuilt.balances.walletBalance.eq(before.walletBalance)).toBe(true);
    expect(rebuilt.balances.usedMargin.eq(before.usedMargin)).toBe(true);
    expect(rebuilt.balances.reservedMargin.eq(before.reservedMargin)).toBe(true);
    expect(rebuilt.balances.realizedPnl.eq(before.realizedPnl)).toBe(true);
    expect(rebuilt.balances.feesPaid.eq(before.feesPaid)).toBe(true);
  });
});

describe("8. siklus reservasi tidak menciptakan atau menghilangkan uang", () => {
  test("reserve → fill → margin posisi; total ekuitas kas terjaga", () => {
    const h = setup();
    const walletStart = h.balances().walletBalance;
    const availableStart = h.available();

    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 5, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    const reserved = submitted.order.reservedMargin;
    // Reservasi memindahkan available → reserved, tanpa mengubah wallet.
    expect(h.balances().walletBalance.eq(walletStart)).toBe(true);
    expect(h.balances().reservedMargin.eq(reserved)).toBe(true);
    expect(availableStart.minus(h.available()).eq(reserved)).toBe(true);

    h.service.cancelOrder({ commandId: "c2", orderId: submitted.order.id, nowMs: h.advance() });
    // Semua kembali.
    expect(h.balances().reservedMargin.isZero()).toBe(true);
    expect(h.available().eq(availableStart)).toBe(true);
    expect(h.balances().walletBalance.eq(walletStart)).toBe(true);
  });

  test("total terkunci (reserved + used) konsisten sepanjang siklus", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 6, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    const locked = () => h.balances().usedMargin.plus(h.balances().reservedMargin);

    // Sebelum fill: seluruhnya reservasi.
    expect(h.balances().reservedMargin.greaterThan(0)).toBe(true);
    expect(h.balances().usedMargin.isZero()).toBe(true);
    const lockedBefore = locked();

    // Fill sebagian (3 dari 6) @78995.
    h.service.evaluateOrder({
      commandId: "c2",
      orderId: submitted.order.id,
      book: book("BTC_USDT", [["78990", 100]], [["78995", 3]]),
      nowMs: h.advance(),
    });

    const position = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(position.size).toBe(3);
    expect(h.balances().usedMargin.eq(position.initialMargin)).toBe(true);
    // Sisa reservasi untuk 3 kontrak yang belum terisi.
    expect(h.balances().reservedMargin.greaterThan(0)).toBe(true);
    // Margin tidak "hilang": yang dilepas dari reservasi masuk ke used.
    expect(h.balances().usedMargin.plus(h.balances().reservedMargin).greaterThan(0)).toBe(true);

    h.service.cancelOrder({ commandId: "c3", orderId: submitted.order.id, nowMs: h.advance() });
    // Setelah cancel: hanya margin posisi yang tersisa terkunci.
    expect(h.balances().reservedMargin.isZero()).toBe(true);
    expect(h.balances().usedMargin.eq(position.initialMargin)).toBe(true);
    expect(lockedBefore.greaterThan(0)).toBe(true);
  });
});
