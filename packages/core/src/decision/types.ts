import type { ContractSpec } from "../contract.js";
import type { Direction } from "../exchange/types.js";
import type { FeatureSnapshot } from "../analytics/features.js";
import type { ScannerResult } from "../analytics/scanner.js";

/**
 * Tipe domain Decision/Risk Engine (Phase 10).
 *
 * Lapisan ini MURNI: hanya menerima snapshot pasar/akun + kebijakan, dan hanya
 * mengeluarkan Decision/TradePlan. Tidak menyentuh DB, repository, OrderService,
 * ledger, saldo, HTTP, waktu, atau acak.
 *
 * Phase 10 berhenti SEBELUM OrderService: TradePlan tidak pernah dikirim ke
 * pasar oleh lapisan ini.
 */

export const DECISION_VERSION = "decision-v1";

export type DecisionAction = "trade" | "skip";

export type DecisionReasonCode =
  // Sinyal
  | "SIGNAL_LONG"
  | "SIGNAL_SHORT"
  | "SIGNAL_NEUTRAL"
  | "SCANNER_SKIPPED"
  | "WARMUP_INCOMPLETE"
  // Konteks pasar
  | "QUOTE_UNAVAILABLE"
  | "MARK_UNAVAILABLE"
  | "MARKET_STALE"
  // Stop / volatilitas
  | "ATR_UNAVAILABLE"
  | "STOP_DISTANCE_TOO_TIGHT"
  | "STOP_DISTANCE_TOO_WIDE"
  | "INVALID_STOP_DISTANCE"
  // Ukuran
  | "RISK_BUDGET_TOO_SMALL"
  | "SIZE_BELOW_MINIMUM"
  | "SIZE_CAPPED_NOTIONAL"
  | "SIZE_CAPPED_CONTRACT_MAX"
  | "SIZE_DECIMAL_FLOORED"
  | "SIZE_FLOORED_INTEGER"
  // Leverage / margin
  | "LEVERAGE_UNAVAILABLE"
  | "INSUFFICIENT_AVAILABLE_BALANCE"
  | "TOTAL_MARGIN_LIMIT"
  // Batas posisi
  | "MAX_OPEN_POSITIONS"
  | "CONTRACT_POSITION_LIMIT"
  | "EXISTING_CONTRACT_POSITION"
  // Reward
  | "REWARD_RISK_TOO_LOW"
  // Keputusan
  | "TRADE_APPROVED";

/** Snapshot pasar yang dibutuhkan keputusan. Mark TIDAK dipakai sebagai entry. */
export interface DecisionMarketContext {
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  /** Untuk valuasi/diagnostik; bukan harga masuk yang diharapkan. */
  readonly markPrice: string | null;
  readonly sourceTimestampMs: number | null;
}

export interface AccountPositionRisk {
  readonly contract: string;
  readonly side: Direction;
  readonly size: number;
  readonly entryPrice: string;
  readonly initialMargin: string;
  readonly unrealizedPnl: string;
}

/**
 * Proyeksi risiko akun yang dioper ke engine murni.
 *
 * Sengaja bukan baris DB dan bukan repository: engine tidak boleh tahu cara
 * mengambilnya. Semua nilai uang berupa string desimal.
 */
export interface AccountRiskState {
  readonly accountId: string;
  readonly walletBalance: string;
  readonly equity: string;
  readonly availableBalance: string;
  readonly positionMargin: string;
  readonly reservedMargin: string;
  readonly openPositionCount: number;
  readonly openPositions: readonly AccountPositionRisk[];
}

export interface TradePlan {
  readonly contract: string;
  readonly side: Direction;
  readonly orderType: "market";
  /** Ukuran kontrak setelah normalisasi (integer untuk kontrak non-desimal). */
  readonly size: number;
  readonly leverage: string;
  readonly referencePrice: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly notional: string;
  readonly initialMargin: string;
  readonly riskAmount: string;
  readonly riskPercent: string;
  readonly rewardAmount: string;
  readonly rewardRiskRatio: string;
  /** Sinyal baseline yang menjadi sumber rencana ini. */
  readonly sourceSignal: Direction;
  readonly stopDistance: string;
  readonly stopDistancePct: string;
}

export interface Decision {
  readonly contract: string;
  readonly timeframe: string;
  readonly candleCloseTimeMs: number;
  readonly accountId: string;

  readonly decisionVersion: string;
  readonly featureVersion: string;
  readonly scannerVersion: string;
  readonly scannerConfigHash: string;
  readonly riskPolicyVersion: string;
  readonly riskPolicyHash: string;

  readonly action: DecisionAction;
  readonly direction: Direction | null;
  readonly reasons: readonly DecisionReasonCode[];
  readonly tradePlan: TradePlan | null;
}

export interface DecisionInput {
  readonly contract: string;
  readonly timeframe: string;
  readonly candleCloseTimeMs: number;
  readonly accountId: string;
  readonly features: FeatureSnapshot;
  readonly scanner: ScannerResult;
  readonly spec: ContractSpec;
  readonly market: DecisionMarketContext;
  readonly account: AccountRiskState;
  readonly policy: import("./risk-policy.js").RiskPolicy;
}
