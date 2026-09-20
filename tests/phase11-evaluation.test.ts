import { describe, expect, test } from "bun:test";
import {
  EVALUATION_VERSION,
  EXECUTION_VERSION,
  actualInitialRiskFor,
  emptyExcursion,
  entrySlippageBpsFor,
  entrySlippageFor,
  evaluateTrades,
  experimentHash,
  netPnlFor,
  rMultipleFor,
  updateExcursion,
  type BaselineExperiment,
  type TradeRecord,
} from "@crypastra/core";

function trade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    tradeId: "t1",
    accountId: "a1",
    decisionId: "d1",
    contract: "BTC_USDT",
    side: "long",
    decisionTimeMs: 1000,
    entryTimeMs: 1000,
    exitTimeMs: 2000,
    plannedReference: "100",
    actualEntry: "100",
    size: 1,
    leverage: "10",
    stopLoss: "99",
    takeProfit: "102",
    plannedRiskAmount: "1",
    actualInitialRiskAmount: "1",
    grossRealizedPnl: "2",
    fees: "0.1",
    funding: "0.05",
    netPnl: "1.85",
    exitReason: "take_profit",
    mae: "0.2",
    mfe: "2.1",
    maeR: "0.2",
    mfeR: "2.1",
    rMultiple: "1.85",
    holdingDurationMs: 1000,
    featureVersion: "features-v1",
    scannerVersion: "scanner-v1",
    scannerConfigHash: "h",
    decisionVersion: "decision-v1",
    riskPolicyVersion: "risk-v1",
    riskPolicyHash: "rh",
    evaluationVersion: EVALUATION_VERSION,
    ...overrides,
  };
}

describe("Phase 11 — matematika trade record", () => {
  test("netPnl = gross − fees − funding (biaya positif)", () => {
    expect(netPnlFor({ grossRealizedPnl: "2", fees: "0.1", funding: "0.05" }).toString()).toBe("1.85");
    // Rebate (fee negatif) menaikkan netPnl.
    expect(netPnlFor({ grossRealizedPnl: "2", fees: "-0.1", funding: "0" }).toString()).toBe("2.1");
  });

  test("R multiple dan penanganan risiko nol", () => {
    expect(rMultipleFor("1.85", "1")!.toString()).toBe("1.85");
    expect(rMultipleFor("-2", "1")!.toString()).toBe("-2");
    expect(rMultipleFor("5", "0")).toBeNull();
  });

  test("risiko awal aktual dari isian sebenarnya", () => {
    expect(
      actualInitialRiskFor({ side: "long", actualEntry: "100", stopLoss: "99", multiplier: "0.0001", size: 125 }).toString(),
    ).toBe("0.0125");
    // SHORT: risiko = SL − entry
    expect(
      actualInitialRiskFor({ side: "short", actualEntry: "100", stopLoss: "101", multiplier: "1", size: 2 }).toString(),
    ).toBe("2");
    // SL di sisi salah → 0, bukan negatif
    expect(
      actualInitialRiskFor({ side: "long", actualEntry: "100", stopLoss: "101", multiplier: "1", size: 1 }).toString(),
    ).toBe("0");
  });

  test("slippage masuk arah-sadar + basis poin", () => {
    expect(entrySlippageFor({ side: "long", actualFill: "100.5", plannedReference: "100" }).toString()).toBe("0.5");
    expect(entrySlippageFor({ side: "short", actualFill: "99.5", plannedReference: "100" }).toString()).toBe("0.5");
    expect(entrySlippageBpsFor({ side: "long", actualFill: "100.5", plannedReference: "100" })!.toString()).toBe("50");
    expect(entrySlippageBpsFor({ side: "long", actualFill: "100", plannedReference: "0" })).toBeNull();
  });

  test("MAE/MFE inkremental dan arah-sadar", () => {
    let state = emptyExcursion();
    state = updateExcursion(state, "long", "100", "101");
    expect(state.mfe.toString()).toBe("1");
    expect(state.mae.toString()).toBe("0");
    state = updateExcursion(state, "long", "100", "98.5");
    expect(state.mfe.toString()).toBe("1");
    expect(state.mae.toString()).toBe("1.5");
    // Mark yang lebih baik tidak mengecilkan MFE, dan sebaliknya.
    state = updateExcursion(state, "long", "100", "100.5");
    expect(state.mfe.toString()).toBe("1");
    expect(state.mae.toString()).toBe("1.5");

    let short = emptyExcursion();
    short = updateExcursion(short, "short", "100", "99");
    short = updateExcursion(short, "short", "100", "103");
    expect(short.mfe.toString()).toBe("1");
    expect(short.mae.toString()).toBe("3");
  });
});

describe("Phase 11 — metrik evaluasi", () => {
  test("skenario campuran: win/loss, PF, expectancy, R", () => {
    const metrics = evaluateTrades({
      trades: [
        trade({ tradeId: "t1", netPnl: "2", rMultiple: "2", exitReason: "take_profit" }),
        trade({ tradeId: "t2", netPnl: "-1", rMultiple: "-1", exitReason: "stop_loss" }),
        trade({ tradeId: "t3", netPnl: "0", rMultiple: "0", exitReason: "manual" }),
      ],
      startingEquity: "1000",
      evaluationVersion: EVALUATION_VERSION,
    });
    expect(metrics.tradeCount).toBe(3);
    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(1);
    expect(metrics.breakeven).toBe(1);
    expect(metrics.winRate).toBe("33.33333333333333333333333333333333333333");
    expect(metrics.grossProfit).toBe("2");
    expect(metrics.grossLoss).toBe("1");
    expect(metrics.netPnl).toBe("1");
    expect(metrics.profitFactor).toBe("2");
    expect(metrics.expectancyPerTrade).toBe("0.3333333333333333333333333333333333333333");
    expect(metrics.averageR).toBe("0.3333333333333333333333333333333333333333");
    expect(metrics.totalR).toBe("1");
    expect(metrics.endingEquity).toBe("1001");
    expect(metrics.tpExits).toBe(1);
    expect(metrics.slExits).toBe(1);
    expect(metrics.manualExits).toBe(1);
  });

  test("tanpa kerugian: profitFactor null, bukan angka besar palsu", () => {
    const metrics = evaluateTrades({
      trades: [trade({ netPnl: "5", rMultiple: "5" })],
      startingEquity: "1000",
      evaluationVersion: EVALUATION_VERSION,
    });
    expect(metrics.grossLoss).toBe("0");
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(0);
  });

  test("tanpa trade: hasil kosong yang valid, tanpa pembagian nol", () => {
    const metrics = evaluateTrades({ trades: [], startingEquity: "1000", evaluationVersion: EVALUATION_VERSION });
    expect(metrics.tradeCount).toBe(0);
    expect(metrics.winRate).toBeNull();
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.expectancyPerTrade).toBeNull();
    expect(metrics.expectancyR).toBeNull();
    expect(metrics.averageR).toBeNull();
    expect(metrics.maxDrawdown).toBe("0");
    expect(metrics.endingEquity).toBe("1000");
  });

  test("max drawdown peak-to-trough pada kurva ekuitas realisasi", () => {
    const metrics = evaluateTrades({
      trades: [
        trade({ tradeId: "t1", exitTimeMs: 1, netPnl: "100", rMultiple: "1" }),
        trade({ tradeId: "t2", exitTimeMs: 2, netPnl: "-150", rMultiple: "-1.5" }),
        trade({ tradeId: "t3", exitTimeMs: 3, netPnl: "50", rMultiple: "0.5" }),
      ],
      startingEquity: "1000",
      evaluationVersion: EVALUATION_VERSION,
    });
    // 1000 → 1100 → 950 → 1000; trough 950, puncak 1100.
    expect(metrics.maxDrawdown).toBe("150");
    expect(metrics.maxDrawdownPct).toBe("13.63636363636363636363636363636363636364");
    expect(metrics.endingEquity).toBe("1000");
    expect(metrics.tradeCount).toBe(3);
  });

  test("trade yang masih terbuka tidak dicampur ke kurva realisasi", () => {
    const metrics = evaluateTrades({
      trades: [trade({ tradeId: "open", exitTimeMs: null, exitReason: "open", netPnl: "0" })],
      startingEquity: "1000",
      evaluationVersion: EVALUATION_VERSION,
    });
    expect(metrics.tradeCount).toBe(0);
    expect(metrics.endingEquity).toBe("1000");
  });

  test("R tanpa nilai valid dilaporkan terpisah", () => {
    const metrics = evaluateTrades({
      trades: [trade({ netPnl: "1", rMultiple: null })],
      startingEquity: "1000",
      evaluationVersion: EVALUATION_VERSION,
    });
    expect(metrics.tradesWithValidR).toBe(0);
    expect(metrics.averageR).toBeNull();
    expect(metrics.totalR).toBe("0");
  });

  test("urutan kurva deterministik walau exit time sama", () => {
    const a = evaluateTrades({
      trades: [
        trade({ tradeId: "b", exitTimeMs: 5, netPnl: "-10", rMultiple: "-1" }),
        trade({ tradeId: "a", exitTimeMs: 5, netPnl: "10", rMultiple: "1" }),
      ],
      startingEquity: "1000",
      evaluationVersion: EVALUATION_VERSION,
    });
    expect(a.maxDrawdown).toBe("10");
  });
});

describe("Phase 11 — identitas eksperimen", () => {
  const base: BaselineExperiment = {
    recordingSession: "s1",
    startingAccountState: "wallet=1000",
    featureVersion: "features-v1",
    scannerVersion: "scanner-v1",
    scannerConfigHash: "sh",
    decisionVersion: "decision-v1",
    riskPolicyHash: "rh",
    executionVersion: EXECUTION_VERSION,
    evaluationVersion: EVALUATION_VERSION,
    execution: "on",
  };

  test("hash stabil, tidak bergantung urutan kunci, sensitif pada perlakuan", () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as BaselineExperiment;
    expect(experimentHash(reordered)).toBe(experimentHash(base));
    expect(experimentHash({ ...base, execution: "off" })).not.toBe(experimentHash(base));
    expect(experimentHash({ ...base, recordingSession: "s2" })).not.toBe(experimentHash(base));
  });
});
