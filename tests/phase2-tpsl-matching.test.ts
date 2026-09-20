import { describe, expect, test } from "bun:test";
import {
  eligibleLevels,
  evaluateTpSl,
  evaluateTpSlBoth,
  InvalidOrderError,
  isMarketable,
  limitCrosses,
  simulateFill,
  triggerReached,
  type TriggerKind,
} from "../packages/core/src/index.js";
import { BTC_USDT } from "./helpers/fixtures.js";

const book = {
  contract: "BTC_USDT",
  updateId: 1,
  eventTsMs: 1,
  bids: [
    { price: "80000", size: 500 },
    { price: "79990", size: 500 },
  ],
  asks: [
    { price: "80010", size: 500 },
    { price: "80020", size: 500 },
  ],
};

describe("7. trigger TP/SL eksplisit", () => {
  const cases: Array<{
    direction: "long" | "short";
    kind: TriggerKind;
    trigger: string;
    observed: string;
    expected: boolean;
    label: string;
  }> = [
    // LONG: TP di atas / sama, SL di bawah / sama
    { direction: "long", kind: "take_profit", trigger: "82000", observed: "82500", expected: true, label: "long TP di atas target" },
    { direction: "long", kind: "take_profit", trigger: "82000", observed: "82000", expected: true, label: "long TP tepat di target (inklusif)" },
    { direction: "long", kind: "take_profit", trigger: "82000", observed: "81999", expected: false, label: "long TP di bawah target" },
    { direction: "long", kind: "stop_loss", trigger: "78000", observed: "77500", expected: true, label: "long SL di bawah target" },
    { direction: "long", kind: "stop_loss", trigger: "78000", observed: "78000", expected: true, label: "long SL tepat di target (inklusif)" },
    { direction: "long", kind: "stop_loss", trigger: "78000", observed: "78001", expected: false, label: "long SL di atas target" },
    // SHORT: TP di bawah / sama, SL di atas / sama
    { direction: "short", kind: "take_profit", trigger: "78000", observed: "77500", expected: true, label: "short TP di bawah target" },
    { direction: "short", kind: "take_profit", trigger: "78000", observed: "78000", expected: true, label: "short TP tepat di target (inklusif)" },
    { direction: "short", kind: "take_profit", trigger: "78000", observed: "78001", expected: false, label: "short TP di atas target" },
    { direction: "short", kind: "stop_loss", trigger: "82000", observed: "82500", expected: true, label: "short SL di atas target" },
    { direction: "short", kind: "stop_loss", trigger: "82000", observed: "82000", expected: true, label: "short SL tepat di target (inklusif)" },
    { direction: "short", kind: "stop_loss", trigger: "82000", observed: "81999", expected: false, label: "short SL di bawah target" },
  ];

  for (const testCase of cases) {
    test(testCase.label, () => {
      expect(
        triggerReached({
          direction: testCase.direction,
          kind: testCase.kind,
          triggerPrice: testCase.trigger,
          observedPrice: testCase.observed,
        }),
      ).toBe(testCase.expected);
    });
  }

  test("evaluateTpSl: SL menang bila KEDUANYA terpenuhi", () => {
    // Kedua trigger hanya bisa terpenuhi bersamaan bila harganya bersilangan
    // (tp <= sl untuk LONG). Untuk LONG pada observed 80000:
    //   TP 70000 → 80000 >= 70000 → true
    //   SL 90000 → 80000 <= 90000 → true
    // Ini keadaan salah konfigurasi, bukan "gap" biasa: dengan urutan wajar
    // (TP > SL) keduanya saling eksklusif pada satu harga.
    expect(evaluateTpSl({ tpPrice: "70000", slPrice: "90000" }, "long", "80000")).toBe("sl");
  });

  test("urutan wajar TP > SL: tidak mungkin keduanya terpenuhi pada satu harga", () => {
    const both = evaluateTpSlBoth({ tpPrice: "82000", slPrice: "78000" }, "long", "80000");
    expect(both).toEqual({ tp: false, sl: false });
    // Gap ke atas: hanya TP
    expect(evaluateTpSl({ tpPrice: "82000", slPrice: "78000" }, "long", "90000")).toBe("tp");
    // Gap ke bawah: hanya SL
    expect(evaluateTpSl({ tpPrice: "82000", slPrice: "78000" }, "long", "70000")).toBe("sl");
  });

  test("evaluateTpSl: tidak ada trigger di antara keduanya", () => {
    expect(evaluateTpSl({ tpPrice: "82000", slPrice: "78000" }, "long", "80000")).toBeNull();
  });

  test("evaluateTpSl: TP saja, SL saja, dan null", () => {
    expect(evaluateTpSl({ tpPrice: "82000", slPrice: null }, "long", "83000")).toBe("tp");
    expect(evaluateTpSl({ tpPrice: null, slPrice: "78000" }, "long", "77000")).toBe("sl");
    expect(evaluateTpSl({ tpPrice: null, slPrice: null }, "long", "80000")).toBeNull();
  });

  test("evaluateTpSlBoth melaporkan keduanya tanpa prioritas", () => {
    expect(evaluateTpSlBoth({ tpPrice: "70000", slPrice: "90000" }, "long", "80000")).toEqual({
      tp: true,
      sl: true,
    });
  });

  test("harga trigger tidak valid ditolak", () => {
    expect(() =>
      triggerReached({ direction: "long", kind: "take_profit", triggerPrice: "0", observedPrice: "1" }),
    ).toThrow();
    expect(() =>
      triggerReached({ direction: "long", kind: "take_profit", triggerPrice: "100", observedPrice: "-1" }),
    ).toThrow();
  });
});

describe("8c. predikat matching", () => {
  test("limit BUY menyentuh bila limit >= best ask", () => {
    expect(limitCrosses("buy", "80010", "80010")).toBe(true);
    expect(limitCrosses("buy", "80011", "80010")).toBe(true);
    expect(limitCrosses("buy", "80009", "80010")).toBe(false);
  });

  test("limit SELL menyentuh bila limit <= best bid", () => {
    expect(limitCrosses("sell", "80000", "80000")).toBe(true);
    expect(limitCrosses("sell", "79999", "80000")).toBe(true);
    expect(limitCrosses("sell", "80001", "80000")).toBe(false);
  });

  test("isMarketable terhadap sisi buku lawan", () => {
    expect(isMarketable("buy", "80010", book.asks)).toBe(true);
    expect(isMarketable("buy", "80009", book.asks)).toBe(false);
    expect(isMarketable("sell", "80000", book.bids)).toBe(true);
    expect(isMarketable("sell", "80001", book.bids)).toBe(false);
    expect(isMarketable("buy", "80010", [])).toBe(false);
  });

  test("eligibleLevels menyaring sesuai arah", () => {
    expect(eligibleLevels("buy", book.asks, "80010")).toHaveLength(1);
    expect(eligibleLevels("buy", book.asks, "80020")).toHaveLength(2);
    expect(eligibleLevels("sell", book.bids, "79990")).toHaveLength(2);
    expect(eligibleLevels("buy", book.asks, null)).toHaveLength(2);
  });

  test("market order tidak boleh punya harga, limit wajib punya harga", () => {
    expect(() =>
      simulateFill(
        BTC_USDT,
        {
          contract: "BTC_USDT",
          side: "buy",
          type: "market",
          size: 1,
          price: "80000",
          leverage: "10",
          timeInForce: "ioc",
          reduceOnly: false,
          tpPrice: null,
          slPrice: null,
        },
        book,
      ),
    ).toThrow(InvalidOrderError);

    expect(() =>
      simulateFill(
        BTC_USDT,
        {
          contract: "BTC_USDT",
          side: "buy",
          type: "limit",
          size: 1,
          price: null,
          leverage: "10",
          timeInForce: "gtc",
          reduceOnly: false,
          tpPrice: null,
          slPrice: null,
        },
        book,
      ),
    ).toThrow(InvalidOrderError);
  });

  test("fill market memakai harga level lawan (taker) dan rata-rata benar", () => {
    const result = simulateFill(
      BTC_USDT,
      {
        contract: "BTC_USDT",
        side: "buy",
        type: "market",
        size: 700,
        price: null,
        leverage: "10",
        timeInForce: "ioc",
        reduceOnly: false,
        tpPrice: null,
        slPrice: null,
      },
      book,
    );
    expect(result.filledSize).toBe(700);
    expect(result.fills.map((fill) => fill.price)).toEqual(["80010", "80020"]);
    // (80010×500 + 80020×200)/700 = 80012.857... → tick 0.1
    expect(result.avgPrice).toBe("80012.9");
  });
});
