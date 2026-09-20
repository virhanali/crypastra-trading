import { describe, expect, test } from "bun:test";
import {
  Decimal,
  deriveAccount,
  feeFor,
  feeRateFor,
  fundingAmount,
  fundingPaymentFor,
  initialMarginFor,
  maintenanceMarginFor,
  pnlFor,
  realizedPnlFor,
  unrealizedPnlFor,
  InvalidLeverageError,
  InvalidRateError,
} from "../packages/core/src/index.js";
import { ARIA_USDT, BTC_USDT, ETH_USDT, PEPE_USDT, SOL_USDT, XRP_USDT } from "./helpers/fixtures.js";

describe("2. PnL linear", () => {
  test("LONG untung / rugi", () => {
    expect(unrealizedPnlFor(BTC_USDT, "long", 1, "80000", "81000").toString()).toBe("0.1");
    expect(unrealizedPnlFor(BTC_USDT, "long", 1, "80000", "79000").toString()).toBe("-0.1");
  });

  test("SHORT untung / rugi", () => {
    expect(unrealizedPnlFor(BTC_USDT, "short", 1, "80000", "79000").toString()).toBe("0.1");
    expect(unrealizedPnlFor(BTC_USDT, "short", 1, "80000", "81000").toString()).toBe("-0.1");
  });

  test("tanpa pergerakan harga PnL = 0 (semua kontrak nyata)", () => {
    for (const spec of [BTC_USDT, ETH_USDT, SOL_USDT, XRP_USDT, PEPE_USDT, ARIA_USDT]) {
      expect(pnlFor(spec, "long", 1, "100", "100").isZero()).toBe(true);
      expect(pnlFor(spec, "short", 1, "100", "100").isZero()).toBe(true);
    }
  });

  test("PnL linear pada jumlah kontrak", () => {
    expect(unrealizedPnlFor(BTC_USDT, "long", 100, "80000", "81000").toString()).toBe("10");
    expect(unrealizedPnlFor(BTC_USDT, "long", 1000, "80000", "81000").toString()).toBe("100");
  });

  test("multiplier heterogen mengubah PnL secara proporsional", () => {
    // SOL multiplier 1: 1 kontrak, gerak 10 → 10 USDT
    expect(unrealizedPnlFor(SOL_USDT, "long", 1, "150", "160").toString()).toBe("10");
    // XRP multiplier 10: gerak 0.1 → 10 × 0.1 = 1 USDT
    expect(unrealizedPnlFor(XRP_USDT, "long", 1, "2.5", "2.6").toString()).toBe("1");
    // ETH multiplier 0.01: gerak 100 → 1 USDT
    expect(unrealizedPnlFor(ETH_USDT, "long", 1, "3000", "3100").toString()).toBe("1");
    // PEPE multiplier 10 juta: gerak 0.0000001 → 1 USDT
    expect(unrealizedPnlFor(PEPE_USDT, "long", 1, "0.00001", "0.0000101").toString()).toBe("1");
  });

  test("harga/tick sangat kecil: PnL dibatasi skala uang 8 dp", () => {
    // ARIA multiplier 100, tick 5 dp. Gerak 1e-8 → 100 × 1e-8 = 1e-6 USDT.
    expect(unrealizedPnlFor(ARIA_USDT, "long", 1, "0.05", "0.05000001").toString()).toBe("0.000001");
    // Gerak di bawah setengah satuan 8 dp dibulatkan ke 0 — konsekuensi skala
    // akuntansi 8 dp (ACCOUNTING.md §1), bukan bug. Kontrak dengan tick sangat
    // kecil butuh ukuran posisi besar agar PnL terwakili.
    expect(unrealizedPnlFor(ARIA_USDT, "long", 1, "0.00000000001", "0.00000000002").isZero()).toBe(true);
    // Dengan 1000 kontrak, gerak 1e-11 menjadi terwakili: 100000 × 1e-11 = 1e-6
    expect(unrealizedPnlFor(ARIA_USDT, "long", 1000, "0.00000000001", "0.00000000002").toString()).toBe(
      "0.000001",
    );
  });

  test("realized = unrealized pada harga yang sama (rumus identik)", () => {
    expect(realizedPnlFor(BTC_USDT, "long", 3, "80000", "80500").toString()).toBe(
      unrealizedPnlFor(BTC_USDT, "long", 3, "80000", "80500").toString(),
    );
  });

  test("harga tidak valid ditolak, tidak menghasilkan PnL karangan", () => {
    expect(() => pnlFor(BTC_USDT, "long", 1, "0", "100")).toThrow();
    expect(() => pnlFor(BTC_USDT, "long", 1, "100", "-1")).toThrow();
  });
});

describe("3. Fee", () => {
  test("BTC fixture: taker 0.006, maker rebate -0.0008", () => {
    expect(feeFor(BTC_USDT, 1, "80000", "taker").fee.toString()).toBe("0.006");
    expect(feeFor(BTC_USDT, 1, "80000", "maker").fee.toString()).toBe("-0.0008");
  });

  test("rate nol → fee nol", () => {
    const zeroFee = { ...BTC_USDT, makerFeeRate: "0", takerFeeRate: "0" };
    expect(feeFor(zeroFee, 5, "80000", "taker").fee.isZero()).toBe(true);
    expect(feeFor(zeroFee, 5, "80000", "maker").fee.isZero()).toBe(true);
  });

  test("maker rebate TIDAK di-clamp ke nol dan tetap negatif", () => {
    const { fee } = feeFor(BTC_USDT, 1, "80000", "maker");
    expect(fee.isNegative()).toBe(true);
    expect(fee.isZero()).toBe(false);
  });

  test("fee rate diambil dari kontrak, bukan konstanta", () => {
    expect(feeRateFor(BTC_USDT, "taker").toString()).toBe("0.00075");
    expect(feeRateFor(BTC_USDT, "maker").toString()).toBe("-0.0001");
  });

  test("notional yang dilaporkan feeFor konsisten dengan contract math", () => {
    expect(feeFor(BTC_USDT, 250, "80000", "taker").notional.toString()).toBe("2000");
    expect(feeFor(SOL_USDT, 1, "150", "taker").notional.toString()).toBe("150");
  });

  test("fee negatif (biaya) dibulatkan KE ATAS, rebate dibulatkan KE BAWAH magnitudonya", () => {
    // Dust +: 1 × 0.0001 × 0.5 × 0.00075 = 0.0000000375 → 0.00000004
    expect(feeFor(BTC_USDT, 1, "0.5", "taker").fee.toString()).toBe("0.00000004");
    // Dust rebate: 1 × 0.0001 × 0.005 × -0.0001 = -0.0000000005 → -0.00000000
    // (magnitudo dibulatkan ke bawah; trader menerima tidak lebih dari eksak)
    const rebate = feeFor(BTC_USDT, 1, "0.005", "maker").fee;
    expect(rebate.isNegative() || rebate.isZero()).toBe(true);
    // Keduanya: trader tidak pernah untung dari pembulatan.
    expect(rebate.greaterThanOrEqualTo("-0.00000001")).toBe(true);
  });

  test("rate tak berhingga ditolak", () => {
    const broken = { ...BTC_USDT, takerFeeRate: "abc" };
    expect(() => feeRateFor(broken, "taker")).toThrow(InvalidRateError);
  });
});

describe("funding", () => {
  test("rate positif: long membayar, short menerima, jumlahnya nol", () => {
    const long = fundingPaymentFor(BTC_USDT, "long", 100, "80000", "0.0001");
    const short = fundingPaymentFor(BTC_USDT, "short", 100, "80000", "0.0001");
    expect(long.isPositive()).toBe(true);
    expect(short.isNegative()).toBe(true);
    expect(long.plus(short).isZero()).toBe(true);
  });

  test("rate negatif membalik arah pembayaran", () => {
    expect(fundingPaymentFor(BTC_USDT, "long", 100, "80000", "-0.0001").isNegative()).toBe(true);
    expect(fundingPaymentFor(BTC_USDT, "short", 100, "80000", "-0.0001").isPositive()).toBe(true);
  });

  test("besaran funding = notional(mark) × rate", () => {
    // 100 kontrak × 0.0001 × 80000 = 800 USDT notional × 0.0001 = 0.08
    expect(fundingAmount(BTC_USDT, 100, "80000", "0.0001").toString()).toBe("0.08");
  });
});

describe("4 & 5. Margin", () => {
  test("BTC fixture: initial margin leverage 10 = 0.8", () => {
    expect(initialMarginFor({ spec: BTC_USDT, size: 1, price: "80000", leverage: "10" }).toString()).toBe("0.8");
  });

  test("maintenance margin BTC fixture = 0.024", () => {
    expect(maintenanceMarginFor(BTC_USDT, 1, "80000").toString()).toBe("0.024");
  });

  test("initial margin naik saat leverage turun, untuk notional yang sama", () => {
    const at10 = initialMarginFor({ spec: BTC_USDT, size: 1, price: "80000", leverage: "10" });
    const at20 = initialMarginFor({ spec: BTC_USDT, size: 1, price: "80000", leverage: "20" });
    const at5 = initialMarginFor({ spec: BTC_USDT, size: 1, price: "80000", leverage: "5" });
    expect(at20.lessThan(at10)).toBe(true);
    expect(at5.greaterThan(at10)).toBe(true);
  });

  test("initial margin dibulatkan KE ATAS (trader menaruh tidak kurang dari eksak)", () => {
    // notional 8 / leverage 3 = 2.666666... → 2.66666667
    const margin = initialMarginFor({ spec: BTC_USDT, size: 1, price: "80000", leverage: "3" });
    expect(margin.toString()).toBe("2.66666667");
    expect(margin.times(3).greaterThanOrEqualTo("8")).toBe(true);
  });

  test("maintenance margin tidak bergantung pada leverage", () => {
    expect(maintenanceMarginFor(BTC_USDT, 1, "80000").toString()).toBe("0.024");
    expect(maintenanceMarginFor(BTC_USDT, 1, "80000").toString()).toBe("0.024");
  });

  test("maintenance margin memakai rate kontrak, bukan konstanta", () => {
    // ARIA mmr 0.08 → 1 × 100 × 0.05 × 0.08 = 0.4
    expect(maintenanceMarginFor(ARIA_USDT, 1, "0.05").toString()).toBe("0.4");
    // SOL mmr 0.005 → 1 × 1 × 150 × 0.005 = 0.75
    expect(maintenanceMarginFor(SOL_USDT, 1, "150").toString()).toBe("0.75");
  });

  test("leverage di luar rentang kontrak ditolak", () => {
    expect(() => initialMarginFor({ spec: BTC_USDT, size: 1, price: "80000", leverage: "2000" })).toThrow(
      InvalidLeverageError,
    );
    expect(() => initialMarginFor({ spec: BTC_USDT, size: 1, price: "80000", leverage: "0" })).toThrow(
      InvalidLeverageError,
    );
  });
});

describe("akun turunan", () => {
  test("available balance dibulatkan KE BAWAH", () => {
    const account = deriveAccount(
      { walletBalance: "100.123456789", usedMargin: "10", reservedMargin: "5" },
      "0",
    );
    // 100.123456789 − 15 = 85.123456789 → floor 8dp = 85.12345678
    expect(account.availableBalance.toString()).toBe("85.12345678");
  });

  test("equity = wallet + unrealized; PnL belum realisasi tidak masuk wallet", () => {
    const account = deriveAccount({ walletBalance: "1000", usedMargin: "80", reservedMargin: "0" }, "12.5");
    expect(account.walletBalance.toString()).toBe("1000");
    expect(account.equity.toString()).toBe("1012.5");
    expect(account.availableBalance.toString()).toBe("920");
  });

  test("margin ratio = used / equity; null saat equity nol", () => {
    expect(deriveAccount({ walletBalance: "1000", usedMargin: "100", reservedMargin: "0" }, "0").marginRatio?.toString()).toBe(
      "0.1",
    );
    expect(deriveAccount({ walletBalance: "0", usedMargin: "100", reservedMargin: "0" }, "0").marginRatio).toBeNull();
  });

  test("available balance bisa negatif secara eksplisit, tidak di-clamp", () => {
    const account = deriveAccount({ walletBalance: "10", usedMargin: "80", reservedMargin: "0" }, "0");
    expect(account.availableBalance.isNegative()).toBe(true);
    expect(account.availableBalance.toString()).toBe("-70");
  });
});

describe("11. identitas ekonomi", () => {
  test("BTC 1 kontrak, gerak +1000 → 0.1 USDT (bukan 10)", () => {
    const qty = new Decimal("0.0001");
    const move = new Decimal("1000");
    expect(qty.times(move).toString()).toBe("0.1");
    expect(unrealizedPnlFor(BTC_USDT, "long", 1, "80000", "81000").toString()).toBe("0.1");
    expect(unrealizedPnlFor(BTC_USDT, "short", 1, "80000", "81000").toString()).toBe("-0.1");
    expect(unrealizedPnlFor(BTC_USDT, "long", 10, "80000", "81000").toString()).toBe("1");
  });
});
