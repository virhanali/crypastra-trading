import type { Direction } from "../exchange/types.js";
import type { FeatureSnapshot } from "../analytics/features.js";
import type { ScannerResult } from "../analytics/scanner.js";
import type { BtcContext } from "../analytics/scanner.js";

/**
 * Lapisan perlakuan intelijen (Phase 12).
 *
 * Jev menjawab "seberapa PROBABEL properti tertentu dari kandidat ini?", BUKAN
 * "LONG atau SHORT?". Ia tidak pernah menentukan ukuran, leverage, SL, TP,
 * alokasi wallet, margin, tipe order, eksekusi, atau PnL — semua itu tetap milik
 * risk-v1 dan Paper Exchange.
 */

export const TREATMENT_VERSION = "treatment-v1";
export const JEV_VETO_POLICY_VERSION = "jev-veto-v1";
export const JEV_EVALUATOR_VERSION = "jev-eval-v1";
export const JEV_PROMPT_VERSION = "jev-prompt-v1";
export const JEV_SCHEMA_VERSION = "jev-schema-v1";

export const EVALUATOR_NAMES = [
  "trend_alignment",
  "momentum_sustainability",
  "reversal_risk",
  "btc_regime",
] as const;
export type EvaluatorName = (typeof EVALUATOR_NAMES)[number];

export type EvaluationStatus = "success" | "invalid" | "unavailable" | "error";

export type TreatmentStatus = "allow" | "veto" | "unavailable" | "invalid";

/**
 * Kontrak input Jev: ringkas, berversi, dan HANYA berisi konteks pasar/riset.
 *
 * DILARANG ada: account id, saldo, equity, margin, leverage, budget risiko,
 * ukuran posisi, PnL, atau hasil trade. Dilarang juga informasi masa depan.
 */
export interface JevInput {
  readonly contract: string;
  readonly timeframe: string;
  readonly candleCloseTimeMs: number;
  /** Arah kandidat dari scanner baseline (bukan pilihan Jev). */
  readonly direction: Direction;

  readonly close: string;
  readonly ema20: string | null;
  readonly ema50: string | null;
  readonly ema200: string | null;
  readonly distanceEma20Pct: string | null;
  readonly distanceEma50Pct: string | null;
  readonly distanceEma200Pct: string | null;
  readonly rsi14: string | null;
  readonly macd: string | null;
  readonly macdSignal: string | null;
  readonly macdHistogram: string | null;
  readonly atr14: string | null;
  readonly atrPercent: string | null;
  readonly return1: string | null;
  readonly return3: string | null;
  readonly return12: string | null;
  readonly volumeRatio: string | null;
  readonly trendStructure: string | null;

  readonly scannerStatus: string;
  readonly scannerSetupType: string;
  readonly scannerReasonCodes: readonly string[];
  readonly scannerFacts: Readonly<Record<string, boolean>>;

  readonly btc: {
    readonly trendStructure: string | null;
    readonly return1: string | null;
    readonly return12: string | null;
    readonly atrPercent: string | null;
  } | null;

  readonly featureVersion: string;
  readonly scannerVersion: string;
  readonly scannerConfigHash: string;
}

/** Output satu evaluator, sudah tervalidasi. Probabilitas berupa string desimal. */
export interface EvaluatorEvaluation {
  readonly evaluator: EvaluatorName;
  readonly evaluatorVersion: string;
  readonly schemaVersion: string;
  readonly probability: string | null;
  /** Khusus `btc_regime`: tiga probabilitas yang menjumlah ~1. */
  readonly regime: {
    readonly supportive: string;
    readonly neutral: string;
    readonly hostile: string;
  } | null;
  readonly confidence: string | null;
  readonly reasonCodes: readonly string[];
  readonly modelMetadata: Readonly<Record<string, string | number | boolean>>;
  readonly status: EvaluationStatus;
}

export interface TreatmentEvaluations {
  readonly trendAlignment: EvaluatorEvaluation | null;
  readonly momentumSustainability: EvaluatorEvaluation | null;
  readonly reversalRisk: EvaluatorEvaluation | null;
  readonly btcRegime: EvaluatorEvaluation | null;
}

export interface TreatmentResult {
  readonly kind: string;
  readonly treatmentVersion: string;
  readonly treatmentConfigHash: string;
  readonly status: TreatmentStatus;
  readonly direction: Direction;
  readonly contract: string;
  readonly timeframe: string;
  readonly candleCloseTimeMs: number;
  readonly inputHash: string;
  readonly evaluations: TreatmentEvaluations;
  readonly reasons: readonly string[];
}

export interface TreatmentInput {
  readonly input: JevInput;
  readonly inputHash: string;
  readonly direction: Direction;
}

/**
 * Abstraksi perlakuan. CONTROL memakai `NoTreatment`; TREATMENT memakai
 * `JevTreatment`. Jangan menebar `if (jev)` di DecisionEngine/RiskEngine.
 */
export interface CandidateTreatment {
  readonly kind: string;
  readonly version: string;
  readonly configHash: string;
  /**
   * SINKRON. Perlakuan hanya membaca evaluasi yang SUDAH tersimpan (cache), jadi
   * jalur replay deterministik tidak pernah menunggu jaringan. Pengambilan
   * evaluasi baru adalah langkah `collect` yang terpisah (§29).
   */
  evaluate(input: TreatmentInput): TreatmentResult;
}

export function buildJevInput(input: {
  features: FeatureSnapshot;
  scanner: ScannerResult;
  btcContext: BtcContext | null;
  direction: Direction;
}): JevInput {
  const { features, scanner, btcContext, direction } = input;
  return {
    contract: features.contract,
    timeframe: features.timeframe,
    candleCloseTimeMs: features.candleCloseTimeMs,
    direction,
    close: features.close,
    ema20: features.ema20,
    ema50: features.ema50,
    ema200: features.ema200,
    distanceEma20Pct: features.distanceEma20Pct,
    distanceEma50Pct: features.distanceEma50Pct,
    distanceEma200Pct: features.distanceEma200Pct,
    rsi14: features.rsi14,
    macd: features.macd,
    macdSignal: features.macdSignal,
    macdHistogram: features.macdHistogram,
    atr14: features.atr14,
    atrPercent: features.atrPercent,
    return1: features.return1,
    return3: features.return3,
    return12: features.return12,
    volumeRatio: features.volumeRatio,
    trendStructure: features.trendStructure,
    scannerStatus: scanner.status,
    scannerSetupType: scanner.setupType,
    scannerReasonCodes: [...scanner.reasonCodes],
    scannerFacts: { ...scanner.facts },
    btc:
      btcContext === null
        ? null
        : {
            trendStructure: btcContext.trendStructure,
            return1: btcContext.return1,
            return12: btcContext.return12,
            atrPercent: btcContext.atrPercent,
          },
    featureVersion: features.featureVersion,
    scannerVersion: scanner.scannerVersion,
    scannerConfigHash: scanner.scannerConfigHash,
  };
}
