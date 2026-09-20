import { describe, expect, test } from "bun:test";
import {
  intervalToSeconds,
  splitCandleName,
  toCandles,
  toTicker,
  toTrades,
} from "../packages/adapters/src/gateio/parse.js";

/**
 * Regresi untuk bug nyata yang ditemukan smoke test live (bukan hipotetis):
 *  1. Nama candle `5m_BTC_USDT` dipotong salah menjadi kontrak "BTC".
 *  2. `size` trade bertanda (negatif = taker sell) kehilangan tandanya.
 * Lihat docs/gateio-market-data.md.
 */

describe("splitCandleName", () => {
  test("kontrak dengan underscore tidak terpotong", () => {
    expect(splitCandleName("5m_BTC_USDT")).toEqual({ interval: "5m", contract: "BTC_USDT" });
  });

  test("kontrak dengan banyak underscore tetap utuh", () => {
    expect(splitCandleName("5m_1000PEPE_USDT")).toEqual({
      interval: "5m",
      contract: "1000PEPE_USDT",
    });
  });

  test("nama malformed ditolak, tidak menebak", () => {
    expect(splitCandleName("BTC_USDT")).toBeNull();
    expect(splitCandleName("5m_")).toBeNull();
    expect(splitCandleName("")).toBeNull();
  });
});

describe("toCandles", () => {
  test("contract BTC_USDT benar, windowClosed dari flag w", () => {
    const candles = toCandles([
      { t: 1789901100, o: "1", h: "2", l: "0.5", c: "1.5", v: 10, n: "5m_BTC_USDT", w: false },
    ]);
    expect(candles).toHaveLength(1);
    expect(candles[0]!.contract).toBe("BTC_USDT");
    expect(candles[0]!.interval).toBe("5m");
    // w:false berarti window BELUM final.
    expect(candles[0]!.windowClosed).toBe(false);
  });

  test("baris tanpa nama valid dilewati, tidak menghasilkan event rusak", () => {
    expect(toCandles([{ t: 1, o: "1", h: "1", l: "1", c: "1", v: 1 }])).toEqual([]);
    expect(toCandles(null)).toEqual([]);
  });
});

describe("toTrades", () => {
  test("size negatif menjadi takerSide sell dengan ukuran absolut", () => {
    const trades = toTrades(
      [
        { id: 1, size: -1600, price: "80312.9", contract: "BTC_USDT", create_time_ms: 1789901291138 },
        { id: 2, size: 500, price: "80313", contract: "BTC_USDT", create_time_ms: 1789901291139 },
      ],
      0,
    );
    expect(trades).toHaveLength(2);
    expect(trades[0]!.size).toBe(1600);
    expect(trades[0]!.takerSide).toBe("sell");
    expect(trades[1]!.size).toBe(500);
    expect(trades[1]!.takerSide).toBe("buy");
  });
});

describe("toTicker", () => {
  test("mark price diambil dari field mark_price, bukan last", () => {
    const ticker = toTicker(
      { contract: "BTC_USDT", last: "80444", mark_price: "80445.79", index_price: "80481.38", t: 1 },
      999,
    );
    expect(ticker?.lastPrice).toBe("80444");
    expect(ticker?.markPrice).toBe("80445.79");
    expect(ticker?.indexPrice).toBe("80481.38");
  });

  test("tanpa contract tidak menghasilkan ticker", () => {
    expect(toTicker({ last: "1" }, 0)).toBeNull();
  });
});

describe("intervalToSeconds", () => {
  test("5m = 300 detik", () => {
    expect(intervalToSeconds("5m")).toBe(300);
    expect(intervalToSeconds("1h")).toBe(3600);
    expect(intervalToSeconds("1d")).toBe(86400);
  });

  test("interval tidak dikenal ditolak, tidak menebak", () => {
    expect(() => intervalToSeconds("5x")).toThrow();
  });
});