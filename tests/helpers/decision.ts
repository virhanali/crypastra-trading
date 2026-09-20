import {
  DEFAULT_RISK_POLICY,
  DEFAULT_SCANNER_CONFIG,
  SCANNER_VERSION,
  FEATURE_VERSION,
  scannerConfigHash,
  type AccountRiskState,
  type DecisionMarketContext,
  type FeatureSnapshot,
  type RiskPolicy,
  type ScannerDirection,
  type ScannerResult,
} from "@crypastra/core";

/** Snapshot fitur minimal untuk uji keputusan (nilai lain tidak relevan). */
export function snapshot(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  const base: FeatureSnapshot = {
    contract: "BTC_USDT",
    timeframe: "5m",
    featureVersion: FEATURE_VERSION,
    candleOpenTimeMs: 1_700_000_000_000,
    candleCloseTimeMs: 1_700_000_300_000,
    candleCount: 250,
    close: "80000",
    ema20: "79900",
    ema50: "79700",
    ema200: "79000",
    rsi14: "60",
    macd: "10",
    macdSignal: "8",
    macdHistogram: "2",
    atr14: "400",
    atrPercent: "0.5",
    return1: "0.001",
    return3: "0.002",
    return12: "0.01",
    volume: 140,
    volumeMa20: "110",
    volumeRatio: "1.27",
    distanceEma20Pct: "0.125",
    distanceEma50Pct: "0.376",
    distanceEma200Pct: "1.265",
    trendStructure: "bullish",
    facts: {
      aboveEma20: true,
      aboveEma50: true,
      aboveEma200: true,
      emaStackedBullish: true,
      emaStackedBearish: false,
      macdAboveSignal: true,
      macdHistogramPositive: true,
      rsiOverbought: false,
      rsiOversold: false,
    },
    warmupComplete: true,
    warmupRemaining: 0,
  };
  return { ...base, ...overrides };
}

export function scannerResult(overrides: Partial<ScannerResult> = {}): ScannerResult {
  const signal: ScannerDirection = overrides.signal ?? "long";
  const base: ScannerResult = {
    contract: "BTC_USDT",
    timeframe: "5m",
    candleCloseTimeMs: 1_700_000_300_000,
    featureVersion: FEATURE_VERSION,
    scannerVersion: SCANNER_VERSION,
    scannerConfigHash: scannerConfigHash(DEFAULT_SCANNER_CONFIG),
    status: signal === "neutral" ? "skip" : "candidate",
    direction: signal === "neutral" ? "neutral" : signal,
    setupType: signal === "long" ? "trend_continuation_long" : signal === "short" ? "trend_continuation_short" : "none",
    facts: {
      trendAligned: true,
      momentumAligned: true,
      volatilityAcceptable: true,
      volumeConfirmed: true,
      overextended: false,
      rsiInRange: true,
    },
    reasonCodes: ["TREND_BULLISH", "MOMENTUM_LONG"],
    signal,
  };
  return { ...base, ...overrides };
}

export function market(overrides: Partial<DecisionMarketContext> = {}): DecisionMarketContext {
  return {
    bestBid: "79999.9",
    bestAsk: "80000",
    markPrice: "80000",
    sourceTimestampMs: 1_700_000_300_000,
    ...overrides,
  };
}

export function account(overrides: Partial<AccountRiskState> = {}): AccountRiskState {
  return {
    accountId: "acct-1",
    walletBalance: "1000",
    equity: "1000",
    availableBalance: "1000",
    positionMargin: "0",
    reservedMargin: "0",
    openPositionCount: 0,
    openPositions: [],
    ...overrides,
  };
}

export function policy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return { ...DEFAULT_RISK_POLICY, ...overrides };
}
