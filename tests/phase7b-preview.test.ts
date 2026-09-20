import { describe, expect, test } from "bun:test";
import { buildOrderPreview, clampLeverage, isMarketable, type MarketQuote } from "../apps/web/src/lib/trade/preview.js";
import { isTickAligned, toApiDecimal } from "../apps/web/src/lib/trade/decimal.js";
import type { ContractDto } from "../apps/web/src/lib/api/types.js";

/** Fixture kontrak NYATA dari Phase 2 (docs/gateio-market-data.md). */
function spec(overrides: Partial<ContractDto>): ContractDto {
  return {
    contract: "BTC_USDT",
    base: "BTC",
    quote: "USDT",
    quantoMultiplier: "0.0001",
    orderSizeMin: 1,
    orderSizeMax: 12000000,
    enableDecimal: false,
    priceTick: "0.1",
    markPriceTick: "0.01",
    leverageMin: "1",
    leverageMax: "200",
    maintenanceRate: "0.003",
    makerFeeRate: "-0.0001",
    takerFeeRate: "0.00075",
    fundingIntervalSeconds: 28800,
    status: "trading",
    ...overrides,
  };
}

const BTC = spec({});
/** ETH: enable_decimal=true, order_size_min=0, multiplier 0.01. */
const ETH = spec({ contract: "ETH_USDT", base: "ETH", quantoMultiplier: "0.01", orderSizeMin: 0, enableDecimal: true, priceTick: "0.01", leverageMax: "200" });
/** SOL: multiplier 1, leverage max 100. */
const SOL = spec({ contract: "SOL_USDT", base: "SOL", quantoMultiplier: "1", orderSizeMin: 0, enableDecimal: true, priceTick: "0.01", leverageMax: "100", maintenanceRate: "0.005" });
/** SATS: tick 11 dp, multiplier 10 juta, integer size. */
const SATS = spec({ contract: "SATS_USDT", base: "SATS", quantoMultiplier: "10000000", priceTick: "0.00000000001", leverageMax: "25", maintenanceRate: "0.02" });
/** ARIA: multiplier 100, leverage max 10. */
const ARIA = spec({ contract: "ARIA_USDT", base: "ARIA", quantoMultiplier: "100", orderSizeMin: 0, enableDecimal: true, priceTick: "0.00001", leverageMax: "10", maintenanceRate: "0.08" });

const QUOTE: MarketQuote = {
  bestBid: "80498.4",
  bestAsk: "80498.5",
  bestBidSize: 500,
  bestAskSize: 300,
  markPrice: "80498.45",
};

function preview(overrides: Partial<Parameters<typeof buildOrderPreview>[0]> = {}) {
  return buildOrderPreview({
    spec: BTC,
    side: "buy",
    type: "market",
    size: "10",
    leverage: "10",
    limitPrice: null,
    takeProfitPrice: null,
    stopLossPrice: null,
    market: QUOTE,
    availableBalance: "10000",
    ...overrides,
  });
}

describe("preview: margin & notional (multiplier heterogen)", () => {
  test("BTC: 10 kontrak, entry di ASK, margin & fee dihitung dari notional", () => {
    const result = preview();
    expect(result.valid).toBe(true);
    expect(result.estimatedEntry).toBe("80498.5");
    // 10 × 0.0001 = 0.001 BTC
    expect(result.baseQuantity).toBe("0.001");
    // 0.001 × 80498.5 = 80.4985
    expect(result.notional).toBe("80.4985");
    // 80.4985 / 10 = 8.04985
    expect(result.estimatedMargin).toBe("8.04985000");
    // 80.4985 × 0.00075 = 0.0603738 75 → CEIL 8dp
    expect(result.estimatedFee).toBe("0.06037388");
    expect(result.liquidity).toBe("taker");
  });

  test("SOL multiplier 1 (bukan 0.0001)", () => {
    const result = preview({ spec: SOL, size: "2", leverage: "10", market: { ...QUOTE, bestAsk: "150", bestBid: "149.9", bestAskSize: 100, bestBidSize: 100 } });
    expect(result.baseQuantity).toBe("2");
    expect(result.notional).toBe("300");
    expect(result.estimatedMargin).toBe("30.00000000");
  });

  test("ETH multiplier 0.01 dan size desimal diizinkan", () => {
    const result = preview({ spec: ETH, size: "0.5", leverage: "10", market: { ...QUOTE, bestAsk: "3000", bestBid: "2999", bestAskSize: 10, bestBidSize: 10 } });
    expect(result.valid).toBe(true);
    expect(result.baseQuantity).toBe("0.005");
    expect(result.notional).toBe("15");
    expect(result.estimatedMargin).toBe("1.50000000");
  });

  test("ARIA multiplier 100 dan leverage maksimum 10", () => {
    const ok = preview({ spec: ARIA, size: "1", leverage: "10", market: { ...QUOTE, bestAsk: "0.05", bestBid: "0.04999", bestAskSize: 1000, bestBidSize: 1000 } });
    expect(ok.notional).toBe("5");
    const bad = preview({ spec: ARIA, size: "1", leverage: "11", market: { ...QUOTE, bestAsk: "0.05", bestBid: "0.04999" } });
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(" ")).toContain("Leverage");
  });
});

describe("preview: size", () => {
  test("sisi LONG memakai ASK, SHORT memakai BID", () => {
    expect(preview({ side: "buy" }).estimatedEntry).toBe("80498.5");
    expect(preview({ side: "sell" }).estimatedEntry).toBe("80498.4");
  });

  test("kontrak integer menolak size desimal", () => {
    const result = preview({ size: "1.5" });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("size bulat");
  });

  test("kontrak desimal MENERIMA size desimal", () => {
    const result = preview({ spec: ETH, size: "0.001", market: { ...QUOTE, bestAsk: "3000", bestBid: "2999" } });
    expect(result.valid).toBe(true);
  });

  test("size di bawah minimum dan di atas maksimum ditolak", () => {
    expect(preview({ size: "0" }).errors.join(" ")).toContain("lebih besar dari 0");
    expect(preview({ size: "99999999" }).errors.join(" ")).toContain("maksimum");
  });

  test("satuan pendamping ditampilkan: kontrak → base → notional", () => {
    const result = preview({ size: "10" });
    expect(result.baseQuantity).toBe("0.001");
    expect(result.notional).toBe("80.4985");
  });
});

describe("preview: leverage", () => {
  test("leverage di luar rentang kontrak ditolak", () => {
    expect(preview({ leverage: "0" }).valid).toBe(false);
    expect(preview({ leverage: "201" }).valid).toBe(false);
    expect(preview({ leverage: "200" }).valid).toBe(true);
  });

  test("margin berubah saat leverage berubah", () => {
    const at10 = preview({ leverage: "10" }).estimatedMargin;
    const at20 = preview({ leverage: "20" }).estimatedMargin;
    expect(at10).toBe("8.04985000");
    expect(at20).toBe("4.02492500");
  });

  test("clampLeverage membatasi tanpa membulatkan diam-diam", () => {
    expect(clampLeverage(ARIA, "25")).toBe("10");
    expect(clampLeverage(ARIA, "0")).toBe("1");
    expect(clampLeverage(ARIA, "7")).toBe("7");
    expect(clampLeverage(null, "7")).toBe("7");
  });
});

describe("preview: marketability limit", () => {
  test("LONG limit marketable saat limit >= ask (batas kesetaraan inklusif)", () => {
    expect(isMarketable("buy", "80498.5", QUOTE)).toBe(true);
    expect(isMarketable("buy", "80498.6", QUOTE)).toBe(true);
    expect(isMarketable("buy", "80498.4", QUOTE)).toBe(false);
  });

  test("SHORT limit marketable saat limit <= bid", () => {
    expect(isMarketable("sell", "80498.4", QUOTE)).toBe(true);
    expect(isMarketable("sell", "80498.3", QUOTE)).toBe(true);
    expect(isMarketable("sell", "80498.5", QUOTE)).toBe(false);
  });

  test("tanpa kutipan tidak ada yang dianggap marketable", () => {
    expect(isMarketable("buy", "1", { bestBid: null, bestAsk: null })).toBe(false);
    expect(isMarketable("sell", "1", { bestBid: null, bestAsk: null })).toBe(false);
  });

  test("limit resting memakai maker dan mengestimasi reservasi", () => {
    const result = preview({ type: "limit", limitPrice: "79000" });
    expect(result.marketable).toBe(false);
    expect(result.liquidity).toBe("maker");
    expect(result.estimatedReservation).toBe("7.90000000");
    expect(result.warnings.join(" ")).toContain("RESTING");
    // Rebate maker tetap negatif dan terlihat.
    expect(result.estimatedFee!.startsWith("-")).toBe(true);
  });

  test("limit marketable memakai taker dan tidak ada reservasi tersisa", () => {
    const result = preview({ type: "limit", limitPrice: "81000" });
    expect(result.marketable).toBe(true);
    expect(result.liquidity).toBe("taker");
    expect(result.estimatedReservation).toBeNull();
    expect(result.warnings.join(" ")).toContain("MARKETABLE");
  });

  test("limit tanpa harga ditolak", () => {
    expect(preview({ type: "limit", limitPrice: null }).errors.join(" ")).toContain("wajib memiliki harga");
  });
});

describe("preview: tick validation", () => {
  test("tick 0.1: 80498.4 valid, 80498.45 tidak", () => {
    expect(preview({ type: "limit", limitPrice: "80498.4" }).valid).toBe(true);
    const bad = preview({ type: "limit", limitPrice: "80498.45" });
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(" ")).toContain("kelipatan tick");
  });

  test("tick 11 dp bekerja tanpa kegagalan floating point", () => {
    expect(isTickAligned("0.00000000003", "0.00000000001")).toBe(true);
    expect(isTickAligned("0.000000000031", "0.00000000001")).toBe(false);
    const result = preview({
      spec: SATS,
      size: "1",
      leverage: "10",
      type: "limit",
      limitPrice: "0.00000000003",
      market: { ...QUOTE, bestAsk: "0.00000000004", bestBid: "0.00000000002", bestAskSize: 10, bestBidSize: 10 },
    });
    expect(result.valid).toBe(true);
    expect(result.marketable).toBe(false);
  });

  test("TP/SL juga divalidasi terhadap tick", () => {
    const bad = preview({ takeProfitPrice: "81000.05" });
    expect(bad.errors.join(" ")).toContain("Take profit harus kelipatan tick");
  });
});

describe("preview: TP/SL semantik arah", () => {
  test("LONG: TP di atas referensi, SL di bawah", () => {
    expect(preview({ takeProfitPrice: "82000", stopLossPrice: "78000" }).valid).toBe(true);
    expect(preview({ takeProfitPrice: "80000" }).errors.join(" ")).toContain("Take profit LONG");
    expect(preview({ stopLossPrice: "82000" }).errors.join(" ")).toContain("Stop loss LONG");
  });

  test("SHORT: TP di bawah referensi, SL di atas", () => {
    expect(preview({ side: "sell", takeProfitPrice: "79000", stopLossPrice: "82000" }).valid).toBe(true);
    expect(preview({ side: "sell", takeProfitPrice: "82000" }).errors.join(" ")).toContain("Take profit SHORT");
  });
});

describe("preview: likuiditas & saldo", () => {
  test("likuiditas puncak buku lebih kecil dari size → peringatan, bukan klaim terisi penuh", () => {
    const result = preview({ size: "500" });
    expect(result.knownExecutableSize).toBe(300);
    expect(result.insufficientKnownLiquidity).toBe(true);
    expect(result.warnings.join(" ")).toContain("terisi sebagian");
  });

  test("ukuran puncak buku tidak diketahui → estimasi dibatasi", () => {
    const result = preview({ market: { ...QUOTE, bestAskSize: null } });
    expect(result.warnings.join(" ")).toContain("tidak diketahui");
  });

  test("saldo virtual tidak cukup ditandai dan tidak valid", () => {
    const result = preview({ size: "100000", availableBalance: "1" });
    expect(result.insufficientBalance).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("Saldo virtual tidak cukup");
  });

  test("saldo cukup → valid", () => {
    expect(preview({ availableBalance: "10000" }).valid).toBe(true);
  });

  test("kutipan hilang → tidak ada estimasi harga eksekusi", () => {
    const result = preview({ market: { bestBid: null, bestAsk: null, bestBidSize: null, bestAskSize: null, markPrice: null } });
    expect(result.valid).toBe(false);
    expect(result.estimatedEntry).toBeNull();
    expect(result.errors.join(" ")).toContain("Kutipan pasar belum tersedia");
  });

  test("mark tidak dipakai sebagai harga eksekusi", () => {
    // Mark 80498.45 berbeda dari ask 80498.5: entry harus memakai ASK.
    const result = preview();
    expect(result.estimatedEntry).toBe("80498.5");
    expect(result.estimatedEntry).not.toBe(QUOTE.markPrice);
  });
});

describe("preview: nilai mentah vs format tampilan", () => {
  test("nilai API tidak pernah memuat pemisah ribuan", () => {
    expect(toApiDecimal("80,498.40")).toBe("80498.40");
    expect(toApiDecimal("1,000")).toBe("1000");
    expect(preview().estimatedMargin!.includes(",")).toBe(false);
  });

  test("preview tidak memakai aritmetika float (uji langsung pada nilai ekstrem)", () => {
    // 0.1 + 0.2 klasik: notional 3 kontrak × 0.0001 × 0.1 harus eksak.
    const result = preview({
      size: "3",
      leverage: "1",
      market: { ...QUOTE, bestAsk: "0.1", bestBid: "0.1", bestAskSize: 100, bestBidSize: 100 },
    });
    expect(result.notional).toBe("0.00003");
    expect(result.estimatedMargin).toBe("0.00003000");
  });
});
