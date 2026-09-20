import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RISK_POLICY,
  DECISION_VERSION,
  RISK_POLICY_VERSION,
  decide,
  decisionHash,
  riskPolicyHash,
  type Decision,
  type DecisionReasonCode,
} from "@crypastra/core";
import { BTC_USDT, ETH_USDT, SATS_USDT } from "./helpers/fixtures.js";
import { account, market, policy, scannerResult, snapshot } from "./helpers/decision.js";

function evaluate(overrides: {
  spec?: typeof BTC_USDT;
  features?: Parameters<typeof snapshot>[0];
  scanner?: Parameters<typeof scannerResult>[0];
  market?: Parameters<typeof market>[0];
  account?: Parameters<typeof account>[0];
  policy?: Parameters<typeof policy>[0];
} = {}): Decision {
  const features = snapshot(overrides.features ?? {});
  const scanner = scannerResult(overrides.scanner ?? {});
  return decide({
    contract: "BTC_USDT",
    timeframe: "5m",
    candleCloseTimeMs: features.candleCloseTimeMs,
    accountId: "acct-1",
    features,
    scanner,
    spec: overrides.spec ?? BTC_USDT,
    market: market({ bestAsk: scanner.signal === "long" ? "80000" : "79999.9", ...overrides.market }),
    account: account(overrides.account ?? {}),
    policy: policy(overrides.policy ?? {}),
  });
}

function reasons(decision: Decision): readonly DecisionReasonCode[] {
  return decision.reasons;
}

describe("Phase 10 — fixture golden LONG", () => {
  const decision = evaluate();

  test("approve dengan rencana yang dapat dihitung tangan", () => {
    expect(decision.action).toBe("trade");
    expect(decision.direction).toBe("long");
    expect(decision.reasons).toContain("TRADE_APPROVED");
    const plan = decision.tradePlan!;
    expect(plan.size).toBe(125);            // floor(10 / 0.08)
    expect(plan.stopLoss).toBe("79200");    // 80000 − 2×400
    expect(plan.takeProfit).toBe("81600");  // 80000 + 2×800
    expect(plan.notional).toBe("1000");     // 125 × 0.0001 × 80000
    expect(plan.leverage).toBe("10");
    expect(plan.initialMargin).toBe("100");
    expect(plan.riskAmount).toBe("10");     // 1% dari equity
    expect(plan.riskPercent).toBe("1");
    expect(plan.rewardAmount).toBe("20");
    expect(plan.rewardRiskRatio).toBe("2");
    expect(plan.stopDistance).toBe("800");
    expect(plan.stopDistancePct).toBe("1");
    expect(plan.sourceSignal).toBe("long");
    expect(plan.orderType).toBe("market");
  });

  test("versi dan hash tercatat untuk reproduksibilitas", () => {
    expect(decision.decisionVersion).toBe(DECISION_VERSION);
    expect(decision.riskPolicyVersion).toBe(RISK_POLICY_VERSION);
    expect(decision.riskPolicyHash).toBe(riskPolicyHash(DEFAULT_RISK_POLICY));
    expect(decision.scannerConfigHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("hash keputusan stabil dan sensitif", () => {
    expect(decisionHash(evaluate())).toBe(decisionHash(decision));
    expect(decisionHash(evaluate({ features: { atr14: "401" } }))).not.toBe(decisionHash(decision));
  });
});

describe("Phase 10 — fixture golden SHORT", () => {
  const decision = evaluate({
    scanner: { signal: "short" },
    market: { bestBid: "79500" },
    features: { atr14: "397.5", trendStructure: "bearish" },
  });

  test("short: SL di atas, TP di bawah, angka eksak", () => {
    expect(decision.action).toBe("trade");
    expect(decision.direction).toBe("short");
    const plan = decision.tradePlan!;
    expect(plan.stopLoss).toBe("80295");    // 79500 + 2×397.5
    expect(plan.takeProfit).toBe("77910");  // 79500 − 2×795
    expect(plan.size).toBe(125);            // floor(10 / 0.0795) = floor(125.78)
    expect(plan.notional).toBe("993.75");
    expect(plan.initialMargin).toBe("99.375");
    expect(plan.riskAmount).toBe("9.9375");
    expect(plan.rewardRiskRatio).toBe("2");
    expect(plan.leverage).toBe("10");
  });

  test("stop di sisi benar untuk kedua arah", () => {
    expect(Number(decision.tradePlan!.stopLoss)).toBeGreaterThan(79500);
    expect(Number(decision.tradePlan!.takeProfit)).toBeLessThan(79500);
  });
});

describe("Phase 10 — sinyal dan konteks pasar", () => {
  test("sinyal netral → skip SIGNAL_NEUTRAL", () => {
    const decision = evaluate({ scanner: { signal: "neutral" } });
    expect(decision.action).toBe("skip");
    expect(decision.direction).toBeNull();
    expect(decision.tradePlan).toBeNull();
    expect(reasons(decision)).toContain("SIGNAL_NEUTRAL");
  });

  test("scanner skip karena warmup dilaporkan eksplisit", () => {
    const decision = evaluate({
      scanner: { signal: "neutral", status: "skip", reasonCodes: ["WARMUP_INCOMPLETE"] },
    });
    expect(reasons(decision)).toContain("WARMUP_INCOMPLETE");
    expect(reasons(decision)).toContain("SCANNER_SKIPPED");
  });

  test("kutipan hilang → skip QUOTE_UNAVAILABLE (bukan memakai mark)", () => {
    const decision = evaluate({ market: { bestAsk: null, markPrice: "80000" } });
    expect(decision.action).toBe("skip");
    expect(reasons(decision)).toContain("QUOTE_UNAVAILABLE");
  });

  test("harga acuan nol → skip QUOTE_UNAVAILABLE", () => {
    expect(reasons(evaluate({ market: { bestAsk: "0" } }))).toContain("QUOTE_UNAVAILABLE");
  });

  test("ATR hilang atau nol → skip ATR_UNAVAILABLE", () => {
    expect(reasons(evaluate({ features: { atr14: null, atrPercent: null } }))).toContain("ATR_UNAVAILABLE");
    expect(reasons(evaluate({ features: { atr14: "0", atrPercent: "0" } }))).toContain("ATR_UNAVAILABLE");
  });
});

describe("Phase 10 — jarak stop", () => {
  test("stop terlalu rapat → STOP_DISTANCE_TOO_TIGHT", () => {
    // ATR 50 → 0.125% < minimum 0.2%
    expect(reasons(evaluate({ features: { atr14: "50" } }))).toContain("STOP_DISTANCE_TOO_TIGHT");
  });

  test("stop terlalu lebar → STOP_DISTANCE_TOO_WIDE", () => {
    // ATR 3000 → 7.5% > maksimum 5%
    expect(reasons(evaluate({ features: { atr14: "3000" } }))).toContain("STOP_DISTANCE_TOO_WIDE");
  });

  test("batas stop tidak diganti model lain secara diam-diam", () => {
    const decision = evaluate({ features: { atr14: "50" } });
    expect(decision.tradePlan).toBeNull();
    expect(decision.action).toBe("skip");
  });
});

describe("Phase 10 — ukuran posisi", () => {
  test("kontrak integer dibulatkan ke bawah dan dilaporkan", () => {
    // riskBudget 10, stopDistance 800 → 125.0 eksak; naikkan ATR agar pecahan.
    const decision = evaluate({ features: { atr14: "410" } });
    expect(Number.isInteger(decision.tradePlan!.size)).toBe(true);
    expect(decision.tradePlan!.size).toBe(121); // floor(10 / 0.082)
    expect(reasons(decision)).toContain("SIZE_FLOORED_INTEGER");
  });

  test("pembulatan tidak dilaporkan bila ukuran sudah eksak", () => {
    // stopDistance 800 → rawSize 125.0 tepat; tidak ada pembulatan.
    expect(reasons(evaluate())).not.toContain("SIZE_FLOORED_INTEGER");
    expect(reasons(evaluate())).not.toContain("SIZE_DECIMAL_FLOORED");
  });

  test("kontrak desimal memakai pecahan dan dicatat", () => {
    const decision = evaluate({ spec: ETH_USDT, features: { atr14: "8" }, market: { bestAsk: "3000" } });
    const plan = decision.tradePlan!;
    expect(plan.size).toBeGreaterThan(0);
    expect(decision.action).toBe("trade");
    expect(plan.notional).toBe(
      (plan.size * Number(ETH_USDT.quantoMultiplier) * Number(plan.referencePrice)).toFixed(
        Number(plan.notional).toString().split(".")[1]?.length ?? 0,
      ),
    );
  });

  test("ukuran di bawah minimum → SIZE_BELOW_MINIMUM", () => {
    // riskBudget sangat kecil → size 0
    const decision = evaluate({ account: { equity: "0.0001", availableBalance: "0.0001" } });
    expect(reasons(decision)).toContain("SIZE_BELOW_MINIMUM");
  });

  test("anggaran risiko nol/negatif → skip", () => {
    const decision = evaluate({ account: { equity: "0", availableBalance: "0" } });
    expect(decision.action).toBe("skip");
    expect(reasons(decision)).toContain("RISK_BUDGET_TOO_SMALL");
  });

  test("cap notional menurunkan ukuran dan menandainya", () => {
    // Stop sangat rapat (ATR 170 → 0.425% masih di atas 0.2%) memperbesar size
    // sehingga cap notional 1% equity berlaku.
    const decision = evaluate({
      features: { atr14: "170" },
      policy: { maxPositionNotionalPct: "1" },
    });
    expect(reasons(decision)).toContain("SIZE_CAPPED_NOTIONAL");
    const plan = decision.tradePlan!;
    // cap = 10 USDT / (0.0001 × 80000) = 1.25 → floor 1 kontrak
    expect(plan.size).toBe(1);
    expect(Number(plan.notional)).toBeLessThanOrEqual(10);
  });

  test("cap kontrak maksimum dihormati", () => {
    const decision = evaluate({
      spec: { ...BTC_USDT, orderSizeMax: 40 },
      features: { atr14: "170" },
    });
    expect(decision.tradePlan!.size).toBeLessThanOrEqual(40);
  });

  test("ukuran tidak pernah dinaikkan oleh cap (hanya turun)", () => {
    const decision = evaluate({ features: { atr14: "170" }, policy: { maxPositionNotionalPct: "1" } });
    expect(decision.tradePlan!.size).toBeLessThanOrEqual(125);
  });
});

describe("Phase 10 — leverage dan margin", () => {
  test("leverage = default kebijakan, bukan keyakinan sinyal", () => {
    expect(evaluate().tradePlan!.leverage).toBe("10");
  });

  test("leverage dijepit oleh maxLeverage kebijakan", () => {
    const decision = evaluate({ policy: { defaultLeverage: "50", maxLeverage: "20" } });
    expect(decision.tradePlan!.leverage).toBe("20");
  });

  test("leverage dijepit oleh batas kontrak", () => {
    // SATS_USDT punya leverageMax 25; ekonomi kontraknya tidak relevan di sini,
    // jadi clamp diuji dengan kontrak BTC berbatas 25.
    const decision = evaluate({
      spec: { ...BTC_USDT, leverageMax: "25" },
      policy: { defaultLeverage: "50", maxLeverage: "100" },
    });
    expect(decision.tradePlan!.leverage).toBe("25");
  });

  test("leverage MINIMUM kontrak dihormati bila default di bawahnya", () => {
    const decision = evaluate({
      spec: { ...BTC_USDT, leverageMin: "20" },
      policy: { defaultLeverage: "5", maxLeverage: "50" },
    });
    expect(decision.tradePlan!.leverage).toBe("20");
  });

  test("saldo tersedia kurang → INSUFFICIENT_AVAILABLE_BALANCE", () => {
    const decision = evaluate({ account: { availableBalance: "50" } });
    expect(reasons(decision)).toContain("INSUFFICIENT_AVAILABLE_BALANCE");
  });

  test("batas margin total → TOTAL_MARGIN_LIMIT", () => {
    const decision = evaluate({ policy: { maxTotalMarginPct: "5" } });
    expect(reasons(decision)).toContain("TOTAL_MARGIN_LIMIT");
  });

  test("margin terpakai diperhitungkan dalam batas total", () => {
    const decision = evaluate({
      account: { positionMargin: "450", availableBalance: "1000", openPositionCount: 0 },
    });
    expect(reasons(decision)).toContain("TOTAL_MARGIN_LIMIT");
  });
});

describe("Phase 10 — batas posisi", () => {
  const openBtc = {
    contract: "BTC_USDT",
    side: "long" as const,
    size: 10,
    entryPrice: "79000",
    initialMargin: "8",
    unrealizedPnl: "1",
  };

  test("sudah ada posisi di kontrak sama → EXISTING_CONTRACT_POSITION", () => {
    const decision = evaluate({
      account: { openPositionCount: 1, openPositions: [openBtc] },
    });
    expect(decision.action).toBe("skip");
    expect(reasons(decision)).toContain("EXISTING_CONTRACT_POSITION");
  });

  test("batas jumlah posisi terbuka → MAX_OPEN_POSITIONS", () => {
    const others = Array.from({ length: 5 }, (_, index) => ({
      ...openBtc,
      contract: `OTHER${index}_USDT`,
    }));
    const decision = evaluate({
      account: { openPositionCount: 5, openPositions: others },
    });
    expect(reasons(decision)).toContain("MAX_OPEN_POSITIONS");
  });

  test("posisi di kontrak lain tidak memblokir selama batas belum tercapai", () => {
    const decision = evaluate({
      account: { openPositionCount: 1, openPositions: [{ ...openBtc, contract: "ETH_USDT" }] },
    });
    expect(decision.action).toBe("trade");
  });
});

describe("Phase 10 — pembulatan tick (termasuk 11 dp)", () => {
  test("SL LONG dibulatkan ke atas sehingga risiko tidak melebihi rencana", () => {
    const decision = evaluate({ spec: BTC_USDT, features: { atr14: "400.07" } });
    const plan = decision.tradePlan!;
    // SL teoretis 79199.86 → tick 0.1 → ceil → 79199.9
    expect(plan.stopLoss).toBe("79199.9");
    expect(Number(plan.stopDistance)).toBeLessThanOrEqual(Number("800.14"));
  });

  test("TP LONG dibulatkan ke bawah sehingga reward tidak dibesar-besarkan", () => {
    const decision = evaluate({ spec: BTC_USDT, features: { atr14: "400.03" } });
    // jarak stop: 79199.94 → ceil 79200 (0.1) → 800; TP = 81600 eksak
    expect(decision.tradePlan!.takeProfit).toBe("81600");
  });

  test("SATS_USDT tick 11 dp dinormalisasi tanpa kehilangan presisi", () => {
    const decision = evaluate({
      spec: SATS_USDT,
      features: { atr14: "0.00000012345", atrPercent: "1" },
      market: { bestAsk: "0.00001234567" },
      account: { equity: "1000", availableBalance: "1000" },
      policy: { defaultLeverage: "2", maxLeverage: "5" },
    });
    const plan = decision.tradePlan;
    if (plan === null) {
      // Kapitalisasi minimum kontrak bisa membuat size < min; itu sah.
      expect(reasons(decision)).toContain("SIZE_BELOW_MINIMUM");
      return;
    }
    const decimals = (plan.stopLoss.split(".")[1] ?? "").length;
    expect(decimals).toBeLessThanOrEqual(11);
    expect(Number(plan.stopLoss)).toBeGreaterThan(0);
  });

  test("RR setelah pembulatan tetap memenuhi minimum, kalau tidak → skip", () => {
    const decision = evaluate({
      spec: { ...BTC_USDT, orderPriceRound: "1" },
      features: { atr14: "400" },
      policy: { minimumRewardRiskRatio: "1.99" },
    });
    const plan = decision.tradePlan;
    if (plan !== null) {
      expect(Number(plan.rewardRiskRatio)).toBeGreaterThanOrEqual(1.99);
    } else {
      expect(reasons(decision)).toContain("REWARD_RISK_TOO_LOW");
    }
  });
});

describe("Phase 10 — invarian rencana yang disetujui", () => {
  const cases = [
    evaluate(),
    evaluate({ scanner: { signal: "short" } }),
    evaluate({ spec: ETH_USDT, features: { atr14: "8" }, market: { bestAsk: "3000" } }),
    evaluate({ features: { atr14: "170" }, policy: { maxPositionNotionalPct: "1" } }),
  ];

  test("tidak ada rencana yang melanggar invarian", () => {
    for (const decision of cases) {
      if (decision.action !== "trade") continue;
      const plan = decision.tradePlan!;
      const pol = DEFAULT_RISK_POLICY;
      const spec = decision.contract === "ETH_USDT" ? ETH_USDT : BTC_USDT;

      expect(plan.size).toBeGreaterThan(0);
      expect(Number(plan.riskAmount)).toBeLessThanOrEqual(1000 * Number(pol.riskPerTradePct) / 100 + 1e-9);
      expect(Number(plan.initialMargin)).toBeLessThanOrEqual(1000);
      expect(Number(plan.leverage)).toBeLessThanOrEqual(Number(pol.maxLeverage));
      expect(Number(plan.leverage)).toBeLessThanOrEqual(Number(spec.leverageMax));
      expect(Number(plan.rewardRiskRatio)).toBeGreaterThanOrEqual(Number(pol.minimumRewardRiskRatio));
      if (plan.side === "long") {
        expect(Number(plan.stopLoss)).toBeLessThan(Number(plan.referencePrice));
        expect(Number(plan.takeProfit)).toBeGreaterThan(Number(plan.referencePrice));
      } else {
        expect(Number(plan.stopLoss)).toBeGreaterThan(Number(plan.referencePrice));
        expect(Number(plan.takeProfit)).toBeLessThan(Number(plan.referencePrice));
      }
    }
  });

  test("riskAmount <= anggaran risiko yang dikonfigurasi", () => {
    for (const decision of cases) {
      if (decision.action !== "trade") continue;
      const budget = 1000 * Number(DEFAULT_RISK_POLICY.riskPerTradePct) / 100;
      expect(Number(decision.tradePlan!.riskAmount)).toBeLessThanOrEqual(budget + 1e-9);
    }
  });
});
