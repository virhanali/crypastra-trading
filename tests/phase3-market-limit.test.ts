import { afterEach, describe, expect, test } from "bun:test";
import { Decimal } from "../packages/core/src/index.js";
import { btcBook, book, intent, setupExchange, type ExchangeHarness } from "./helpers/exchange.js";
import { BTC_USDT, ETH_USDT } from "./helpers/fixtures.js";

const harnesses: ExchangeHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

function setup(balance = "10000"): ExchangeHarness {
  const h = setupExchange({ initialBalance: balance, specs: [BTC_USDT, ETH_USDT] });
  harnesses.push(h);
  return h;
}

describe("6. MARKET order", () => {
  test("BUY size 5 mengonsumsi 3 level dengan harga masing-masing", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 5, type: "market" }),
      book: book(
        "BTC_USDT",
        [["79990", 10]],
        [
          ["80000", 1],
          ["80010", 2],
          ["80020", 2],
        ],
      ),
      nowMs: h.now(),
    });

    expect(result.fills).toHaveLength(3);
    expect(result.fills.map((fill) => fill.size)).toEqual([1, 2, 2]);
    expect(result.fills.map((fill) => fill.price.toString())).toEqual(["80000", "80010", "80020"]);
    expect(result.order.filledSize).toBe(5);
    expect(result.order.status).toBe("filled");
    // Rata-rata tertimbang: (80000×1 + 80010×2 + 80020×2)/5 = 80012
    expect(result.order.avgFillPrice!.toString()).toBe("80012");
  });

  test("posisi LONG dibuat dengan entry = rata-rata tertimbang", () => {
    const h = setup();
    h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 5, type: "market" }),
      book: book("BTC_USDT", [["79990", 10]], [
        ["80000", 1],
        ["80010", 2],
        ["80020", 2],
      ]),
      nowMs: h.now(),
    });

    const position = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(position.direction).toBe("long");
    expect(position.size).toBe(5);
    expect(position.entryPrice.toString()).toBe("80012");
  });

  test("fee taker dihitung PER FILL, bukan dari rata-rata", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 3, type: "market" }),
      book: book("BTC_USDT", [["79990", 10]], [
        ["80000", 1],
        ["80010", 2],
      ]),
      nowMs: h.now(),
    });

    // fill 1: 1 × 0.0001 × 80000 × 0.00075 = 0.006
    // fill 2: 2 × 0.0001 × 80010 × 0.00075 = 0.0120015
    expect(result.fills[0]!.fee.toString()).toBe("0.006");
    expect(result.fills[1]!.fee.toString()).toBe("0.0120015");
    expect(result.fills.every((fill) => fill.liquidity === "taker")).toBe(true);

    const balances = h.balances();
    expect(balances.feesPaid.toString()).toBe("0.0180015");
  });

  test("SELL membuka posisi SHORT dan memakai sisi bid", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "sell", size: 2, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.fills[0]!.price.toString()).toBe("79990");
    const position = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(position.direction).toBe("short");
    expect(position.size).toBe(2);
  });

  test("kedalaman tidak cukup → partial fill (IOC), sisa dibatalkan", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 10, type: "market" }),
      book: book("BTC_USDT", [["79990", 10]], [
        ["80000", 2],
        ["80010", 3],
      ]),
      nowMs: h.now(),
    });

    expect(result.fills.map((fill) => fill.size)).toEqual([2, 3]);
    expect(result.order.filledSize).toBe(5);
    expect(result.order.reservedMargin.toString()).toBe("0");
    expect(result.order.status).toBe("partially_filled");
    // Order immediate tidak resting, jadi tidak live.
    expect(h.orders.listLive(h.accountId)).toHaveLength(0);
  });

  test("buku kosong → tidak ada fill, order cancelled, tidak ada efek ekonomi", () => {
    const h = setup();
    const before = h.balances().walletBalance;
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market" }),
      book: book("BTC_USDT", [], []),
      nowMs: h.now(),
    });

    expect(result.fills).toHaveLength(0);
    expect(result.order.status).toBe("cancelled");
    expect(h.balances().walletBalance.eq(before)).toBe(true);
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")).toBeNull();
    expect(h.fills.count()).toBe(0);
  });

  test("FOK yang tidak terpenuhi sepenuhnya dibatalkan tanpa fill", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 5, type: "limit", price: "80010", timeInForce: "fok" }),
      book: book("BTC_USDT", [["79990", 10]], [["80000", 2]]),
      nowMs: h.now(),
    });
    expect(result.fills).toHaveLength(0);
    expect(result.order.status).toBe("cancelled");
    expect(h.fills.count()).toBe(0);
  });

  test("FOK yang terpenuhi sepenuhnya terisi", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 2, type: "limit", price: "80000", timeInForce: "fok" }),
      book: book("BTC_USDT", [["79990", 10]], [["80000", 5]]),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("filled");
    expect(result.order.filledSize).toBe(2);
  });
});

describe("7. LIMIT order", () => {
  test("limit yang menyentuh buku dieksekusi taker", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 2, type: "limit", price: "80000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("filled");
    expect(result.fills[0]!.liquidity).toBe("taker");
    expect(result.fills[0]!.price.toString()).toBe("80000");
    // Limit marketable tidak resting, jadi tidak ada reservasi tersisa.
    expect(result.order.reservedMargin.toString()).toBe("0");
  });

  test("limit yang tidak menyentuh buku → open, reservasi margin, tanpa fill", () => {
    const h = setup();
    const before = h.available();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 5, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.now(),
    });

    expect(result.order.status).toBe("open");
    expect(result.fills).toHaveLength(0);
    expect(h.fills.count()).toBe(0);
    // reservasi = 5 × 0.0001 × 79000 / 10 = 3.95
    expect(result.order.reservedMargin.toString()).toBe("3.95");
    expect(h.balances().reservedMargin.toString()).toBe("3.95");
    expect(h.balances().usedMargin.toString()).toBe("0");
    expect(before.minus(h.available()).toString()).toBe("3.95");
    expect(h.orders.listLive(h.accountId)).toHaveLength(1);
  });

  test("limit sell di atas bid → open resting", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "sell", size: 2, type: "limit", price: "81000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("open");
    expect(result.order.reservedMargin.toString()).toBe("1.62");
  });

  test("post_only yang menyentuh buku ditolak tanpa efek ekonomi", () => {
    const h = setup();
    const before = h.balances().walletBalance;
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "limit", price: "80010", timeInForce: "post_only" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.fills).toHaveLength(0);
    expect(h.balances().walletBalance.eq(before)).toBe(true);
    expect(h.balances().reservedMargin.toString()).toBe("0");
  });

  test("post_only yang tidak menyentuh buku menjadi resting maker", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "limit", price: "79000", timeInForce: "post_only" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("open");
    expect(result.order.reservedMargin.toString()).toBe("0.79");
  });

  test("order resting yang tersentuh snapshot baru terisi sebagai maker", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 4, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    expect(submitted.order.status).toBe("open");
    const reservedBefore = h.balances().reservedMargin;
    const availableBefore = h.available();
    const walletBefore = h.balances().walletBalance;

    // Snapshot baru: ask turun menembus limit.
    const evaluated = h.service.evaluateOrder({
      commandId: "c2",
      orderId: submitted.order.id,
      book: book("BTC_USDT", [["78990", 10]], [["78995", 4]]),
      nowMs: h.advance(),
    });

    expect(evaluated.fills).toHaveLength(1);
    expect(evaluated.fills[0]!.price.toString()).toBe("78995");
    expect(evaluated.order.status).toBe("filled");
    expect(evaluated.order.filledSize).toBe(4);
    // Reservasi berpindah menjadi margin posisi, jadi reserved kembali 0.
    expect(h.balances().reservedMargin.toString()).toBe("0");
    expect(reservedBefore.toString()).toBe("3.16");

    const position = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(position.size).toBe(4);
    expect(position.entryPrice.toString()).toBe("78995");
    // Margin posisi memakai harga fill (78995), bukan harga limit (79000).
    expect(position.initialMargin.toString()).toBe("3.1598");

    // Identitas akuntansi: available = wallet − used − reserved, dan
    // perpindahan reservasi→margin tidak menciptakan atau menghilangkan uang.
    const balances = h.balances();
    const fee = evaluated.fills[0]!.fee;
    expect(balances.walletBalance.eq(walletBefore.minus(fee))).toBe(true);
    expect(balances.usedMargin.eq(position.initialMargin)).toBe(true);
    expect(balances.reservedMargin.eq(new Decimal(0))).toBe(true);
    expect(
      balances.walletBalance.minus(balances.usedMargin).minus(balances.reservedMargin).eq(h.available()),
    ).toBe(true);
    void availableBefore;
  });

  test("evaluasi order yang sudah final ditolak", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    expect(() =>
      h.service.evaluateOrder({
        commandId: "c2",
        orderId: submitted.order.id,
        book: btcBook(),
        nowMs: h.advance(),
      }),
    ).toThrow();
  });
});

describe("17 & 18. partial fill dan multi-level", () => {
  test("partial fill bertahap lalu cancel melepas sisa reservasi saja", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 10, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    expect(submitted.order.reservedMargin.toString()).toBe("7.9");

    // Tahap 1: 5 kontrak terisi.
    const first = h.service.evaluateOrder({
      commandId: "c2",
      orderId: submitted.order.id,
      book: book("BTC_USDT", [["78990", 10]], [["78995", 5]]),
      nowMs: h.advance(),
    });
    expect(first.order.filledSize).toBe(5);
    expect(first.order.status).toBe("partially_filled");
    expect(h.orders.listLive(h.accountId)).toHaveLength(1);
    // Sisa ukuran 5 → reservasi sisa 5 × 0.0001 × 79000 / 10 = 3.95
    expect(first.order.reservedMargin.toString()).toBe("3.95");
    expect(h.balances().reservedMargin.toString()).toBe("3.95");
    // Margin posisi dari fill 5 kontrak @78995: 5 × 0.0001 × 78995 / 10 = 3.94975
    expect(h.balances().usedMargin.toString()).toBe("3.94975");

    // Tahap 2: 2 kontrak lagi.
    const second = h.service.evaluateOrder({
      commandId: "c3",
      orderId: submitted.order.id,
      book: book("BTC_USDT", [["78990", 10]], [["78995", 2]]),
      nowMs: h.advance(),
    });
    expect(second.order.filledSize).toBe(7);
    expect(second.order.status).toBe("partially_filled");
    // Sisa 3 → reservasi 3 × 0.0001 × 79000 / 10 = 2.37
    expect(second.order.reservedMargin.toString()).toBe("2.37");

    // Cancel: hanya sisa 3 yang dilepas; fill dan posisi tidak tersentuh.
    const positionBefore = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    const fillCountBefore = h.fills.count();
    const cancelled = h.service.cancelOrder({
      commandId: "c4",
      orderId: submitted.order.id,
      nowMs: h.advance(),
    });
    expect(cancelled.order.status).toBe("cancelled");
    expect(cancelled.order.reservedMargin.toString()).toBe("0");
    expect(h.balances().reservedMargin.toString()).toBe("0");
    expect(h.fills.count()).toBe(fillCountBefore);

    const positionAfter = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(positionAfter.id).toBe(positionBefore.id);
    expect(positionAfter.size).toBe(7);
    expect(positionAfter.initialMargin.eq(positionBefore.initialMargin)).toBe(true);
  });

  test("multi-level menghasilkan satu fill per level dengan fee per fill", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 5, type: "market" }),
      book: book("BTC_USDT", [["79990", 10]], [
        ["80000", 1],
        ["80010", 2],
        ["80020", 2],
      ]),
      nowMs: h.now(),
    });

    expect(result.fills).toHaveLength(3);
    expect(result.fills.map((fill) => fill.size)).toEqual([1, 2, 2]);
    // Total fee = Σ per fill
    const totalFee = result.fills.reduce((sum, fill) => sum.plus(fill.fee), new Decimal(0));
    expect(h.balances().feesPaid.eq(totalFee)).toBe(true);
    // Rata-rata: (80000×1 + 80010×2 + 80020×2)/5 = 80012
    expect(result.order.avgFillPrice!.toString()).toBe("80012");
    expect(result.order.filledSize).toBe(5);
  });
});

describe("12. fee maker dan rebate", () => {
  test("fill maker memberi rebate (fee negatif) dan menambah saldo", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    const walletBefore = h.balances().walletBalance;

    const evaluated = h.service.evaluateOrder({
      commandId: "c2",
      orderId: submitted.order.id,
      book: book("BTC_USDT", [["78990", 10]], [["78995", 1]]),
      nowMs: h.advance(),
    });

    const fee = evaluated.fills[0]!.fee;
    expect(evaluated.fills[0]!.liquidity).toBe("maker");
    // 1 × 0.0001 × 78995 × (−0.0001) = −0.00000078995 → CEIL 8dp
    expect(fee.isNegative()).toBe(true);
    // Rebate menambah saldo (fee negatif → amount positif di ledger).
    expect(h.balances().walletBalance.greaterThan(walletBefore)).toBe(true);
    // fees_paid negatif = trader menerima rebate.
    expect(h.balances().feesPaid.isNegative()).toBe(true);
  });

  test("fee tidak pernah di-clamp ke nol", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    const evaluated = h.service.evaluateOrder({
      commandId: "c2",
      orderId: submitted.order.id,
      book: book("BTC_USDT", [["78990", 10]], [["78995", 1]]),
      nowMs: h.advance(),
    });
    expect(evaluated.fills[0]!.fee.isZero()).toBe(false);
  });
});

describe("13. cancel", () => {
  test("cancel melepas reservasi penuh dan menulis event", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 4, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    expect(h.balances().reservedMargin.toString()).toBe("3.16");

    const cancelled = h.service.cancelOrder({
      commandId: "c2",
      orderId: submitted.order.id,
      nowMs: h.advance(),
    });
    expect(cancelled.order.status).toBe("cancelled");
    expect(h.balances().reservedMargin.toString()).toBe("0");
    // Reservasi dilepas penuh; tidak ada fill, jadi saldo dan fee tidak berubah.
    expect(h.balances().walletBalance.eq(new Decimal("10000"))).toBe(true);
    expect(h.balances().feesPaid.isZero()).toBe(true);
    expect(h.available().eq(new Decimal("10000"))).toBe(true);

    const events = h.orders.events(submitted.order.id);
    expect(events.map((event) => event.type)).toContain("cancelled");
  });

  test("cancel order yang sudah final ditolak", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    h.service.cancelOrder({ commandId: "c2", orderId: submitted.order.id, nowMs: h.advance() });
    expect(() =>
      h.service.cancelOrder({ commandId: "c3", orderId: submitted.order.id, nowMs: h.advance() }),
    ).toThrow();
    // Tidak melepas dua kali.
    expect(h.balances().reservedMargin.toString()).toBe("0");
  });

  test("cancel tidak menyentuh fill dan posisi yang sudah ada", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 3, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    h.service.evaluateOrder({
      commandId: "c2",
      orderId: submitted.order.id,
      book: book("BTC_USDT", [["78990", 10]], [["78995", 1]]),
      nowMs: h.advance(),
    });
    const fillsBefore = h.fills.count();
    const positionBefore = h.positions.findOpen(h.accountId, "BTC_USDT")!;

    h.service.cancelOrder({ commandId: "c3", orderId: submitted.order.id, nowMs: h.advance() });

    expect(h.fills.count()).toBe(fillsBefore);
    const positionAfter = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(positionAfter.id).toBe(positionBefore.id);
    expect(positionAfter.size).toBe(positionBefore.size);
  });
});

describe("14. ledger", () => {
  test("efek ledger lengkap dan dapat direkonstruksi", () => {
    const h = setup();
    h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 2, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });

    const entries = h.ledger.list(h.accountId);
    const types = entries.map((entry) => entry.type);
    expect(types).toContain("margin_lock");
    expect(types).toContain("fee");

    // Cache saldo cocok dengan hasil turunan ledger.
    const verified = h.ledger.verifyBalances(h.accountId);
    expect(verified.chainMismatch).toBeNull();
    expect(verified.cacheMatches).toBe(true);
  });

  test("idempotency key ledger deterministik per fill", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 2, type: "market" }),
      book: book("BTC_USDT", [["79990", 10]], [["80000", 1], ["80010", 1]]),
      nowMs: h.now(),
    });
    const keys = h.ledger.list(h.accountId).map((entry) => entry.idempotencyKey);
    for (const fill of result.fills) {
      expect(keys).toContain(`fill:${fill.fillId}:fee`);
      expect(keys).toContain(`fill:${fill.fillId}:margin`);
    }
    // Tidak ada kunci ganda.
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("margin posisi naik dan reservasi nol setelah fill market", () => {
    const h = setup();
    h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 2, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    const balances = h.balances();
    // 2 × 0.0001 × 80000 / 10 = 1.6
    expect(balances.usedMargin.toString()).toBe("1.6");
    expect(balances.reservedMargin.toString()).toBe("0");
    expect(h.positions.totalOpenMargin(h.accountId).eq(balances.usedMargin)).toBe(true);
  });
});
