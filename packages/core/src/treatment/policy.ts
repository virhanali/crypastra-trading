import { z } from "zod";
import { Decimal } from "../money.js";
import { fingerprint } from "../exchange/canonical.js";
import { JEV_VETO_POLICY_VERSION, type TreatmentEvaluations, type TreatmentStatus } from "./types.js";

/**
 * Kebijakan veto `jev-veto-v1` — DETERMINISTIK dan MURNI.
 *
 * Jev tidak memutuskan langsung. Ia hanya menyuplai probabilitas; kebijakan
 * inilah yang memutuskan ALLOW/VETO. Seluruh ambang hidup di satu config yang
 * dapat diserialisasi dan di-hash.
 *
 * Default bersifat EKSPERIMENTAL, bukan hasil optimasi, dan TIDAK dioptimasi
 * terhadap hasil replay. Jarak probabilitas ke ambang TIDAK dipakai untuk
 * menurunkan leverage atau ukuran apa pun.
 */
export const JevVetoConfigSchema = z.object({
  minimumTrendAlignment: z.string().default("0.55"),
  minimumMomentumSustainability: z.string().default("0.55"),
  maximumReversalRisk: z.string().default("0.45"),
  maximumBtcHostileProbability: z.string().default("0.5"),
  /** Bila true, evaluator btc_regime wajib ada dan valid. */
  requireBtcEvaluator: z.boolean().default(false),
});

export type JevVetoConfig = z.infer<typeof JevVetoConfigSchema>;

export const DEFAULT_JEV_VETO_CONFIG: JevVetoConfig = JevVetoConfigSchema.parse({});

export function jevVetoConfigHash(config: JevVetoConfig): string {
  const parsed = JevVetoConfigSchema.parse(config);
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parsed).sort()) {
    ordered[key] = (parsed as Record<string, unknown>)[key];
  }
  return fingerprint(JSON.stringify(ordered));
}

export interface VetoDecision {
  readonly status: TreatmentStatus;
  readonly reasons: readonly string[];
}

/**
 * Terapkan kebijakan veto.
 *
 * Urutan pemeriksaan deterministik:
 *   1. kelengkapan evaluator (fail closed)
 *   2. trend alignment minimum
 *   3. momentum sustainability minimum
 *   4. reversal risk maksimum
 *   5. BTC hostile maksimum (bila evaluatornya ada/diwajibkan)
 */
export function applyJevVetoPolicy(
  evaluations: TreatmentEvaluations,
  config: JevVetoConfig = DEFAULT_JEV_VETO_CONFIG,
): VetoDecision {
  const trend = evaluations.trendAlignment;
  const momentum = evaluations.momentumSustainability;
  const reversal = evaluations.reversalRisk;
  const btc = evaluations.btcRegime;

  // ── 1. Kelengkapan (fail closed) ────────────────────────────────
  if (trend === null || momentum === null || reversal === null) {
    return { status: "unavailable", reasons: ["JEV_EVALUATION_MISSING"] };
  }
  if (trend.status === "unavailable" || momentum.status === "unavailable" || reversal.status === "unavailable") {
    return { status: "unavailable", reasons: ["JEV_UNAVAILABLE"] };
  }
  if (trend.status !== "success" || momentum.status !== "success" || reversal.status !== "success") {
    return { status: "invalid", reasons: ["JEV_INVALID_OUTPUT"] };
  }
  if (config.requireBtcEvaluator && (btc === null || btc.status !== "success")) {
    return btc !== null && btc.status === "unavailable"
      ? { status: "unavailable", reasons: ["JEV_UNAVAILABLE"] }
      : { status: "invalid", reasons: ["JEV_INVALID_OUTPUT"] };
  }

  const reasons: string[] = [];

  // ── 2..5. Ambang ────────────────────────────────────────────────
  if (new Decimal(trend.probability!).lessThan(new Decimal(config.minimumTrendAlignment))) {
    reasons.push("JEV_TREND_ALIGNMENT_BELOW_MINIMUM");
  }
  if (new Decimal(momentum.probability!).lessThan(new Decimal(config.minimumMomentumSustainability))) {
    reasons.push("JEV_MOMENTUM_UNSUSTAINABLE");
  }
  if (new Decimal(reversal.probability!).greaterThan(new Decimal(config.maximumReversalRisk))) {
    reasons.push("JEV_REVERSAL_RISK_TOO_HIGH");
  }
  // Ambang BTC HANYA berlaku bila evaluator BTC diminta eksplisit. Tanpa itu,
  // probabilitas BTC tetap terekam untuk riset tetapi tidak memveto.
  if (
    config.requireBtcEvaluator &&
    btc !== null &&
    btc.status === "success" &&
    btc.regime !== null &&
    new Decimal(btc.regime.hostile).greaterThan(new Decimal(config.maximumBtcHostileProbability))
  ) {
    reasons.push("JEV_BTC_REGIME_HOSTILE");
  }

  if (reasons.length > 0) {
    return { status: "veto", reasons };
  }
  return { status: "allow", reasons: ["JEV_TREATMENT_ALLOWED"] };
}

export const JEV_VETO_POLICY = JEV_VETO_POLICY_VERSION;
