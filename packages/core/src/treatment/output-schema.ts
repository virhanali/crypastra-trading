import { z } from "zod";
import { Decimal } from "../money.js";
import { EVALUATOR_NAMES, type EvaluatorName, type EvaluatorEvaluation } from "./types.js";

/**
 * Output Jev diperlakukan sebagai input EKSTERNAL YANG TIDAK DIPERCAYA.
 * Validasi ketat; tidak ada nilai trading yang diekstrak dari prosa.
 */

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;
const ProbabilityString = z.string().trim().regex(DECIMAL_STRING, "probabilitas harus string desimal");
const ShortCode = z.string().trim().min(1).max(64);

const MetadataValue = z.union([z.string().max(200), z.number(), z.boolean()]);

export const EvaluatorOutputSchema = z
  .object({
    evaluator: z.enum(EVALUATOR_NAMES),
    evaluatorVersion: z.string().trim().min(1).max(64),
    schemaVersion: z.string().trim().min(1).max(64),
    probability: ProbabilityString.nullable().optional(),
    regime: z
      .object({
        supportive: ProbabilityString,
        neutral: ProbabilityString,
        hostile: ProbabilityString,
      })
      .strict()
      .nullable()
      .optional(),
    confidence: ProbabilityString.nullable().optional(),
    reasonCodes: z.array(ShortCode).max(32).default([]),
    /**
     * Status internal (diisi validator, bukan oleh provider). Diterima di sini
     * supaya bentuk domain `EvaluatorEvaluation` dapat divalidasi ulang tanpa
     * cabang khusus; provider yang mengirimnya tetap tidak dipercaya.
     */
    status: z.enum(["success", "invalid", "unavailable", "error"]).optional(),
    /** Hanya metadata aman; rahasia TIDAK boleh masuk sini. */
    modelMetadata: z.record(z.string().max(64), MetadataValue).default({}),
  })
  .strict();

export type RawEvaluatorOutput = z.infer<typeof EvaluatorOutputSchema>;

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly evaluation: EvaluatorEvaluation | null;
  readonly reasonCode: "JEV_OK" | "JEV_INVALID_OUTPUT";
  readonly detail: string | null;
}

function inUnitRange(value: string): boolean {
  const decimal = new Decimal(value);
  return decimal.isFinite() && decimal.greaterThanOrEqualTo(0) && decimal.lessThanOrEqualTo(1);
}

/**
 * Validasi output satu evaluator.
 *
 * Menolak: evaluator hilang/salah, NaN, probabilitas < 0 atau > 1, JSON
 * cacat/berlebih (schema `.strict()`), dan schemaVersion yang tidak dikenal.
 * Semua kegagalan → `JEV_INVALID_OUTPUT` (fail closed).
 */
export function validateEvaluatorOutput(
  expected: EvaluatorName,
  expectedSchemaVersion: string,
  raw: unknown,
): ValidationOutcome {
  const parsed = EvaluatorOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, evaluation: null, reasonCode: "JEV_INVALID_OUTPUT", detail: "skema output tidak valid" };
  }
  const output = parsed.data;
  if (output.evaluator !== expected) {
    return {
      ok: false,
      evaluation: null,
      reasonCode: "JEV_INVALID_OUTPUT",
      detail: `evaluator tidak sesuai: ${output.evaluator} != ${expected}`,
    };
  }
  if (output.schemaVersion !== expectedSchemaVersion) {
    return {
      ok: false,
      evaluation: null,
      reasonCode: "JEV_INVALID_OUTPUT",
      detail: `schemaVersion tidak dikenal: ${output.schemaVersion}`,
    };
  }

  if (expected === "btc_regime") {
    if (output.regime === null || output.regime === undefined) {
      return { ok: false, evaluation: null, reasonCode: "JEV_INVALID_OUTPUT", detail: "regime wajib untuk btc_regime" };
    }
    for (const [label, value] of Object.entries(output.regime)) {
      if (!inUnitRange(value)) {
        return { ok: false, evaluation: null, reasonCode: "JEV_INVALID_OUTPUT", detail: `probabilitas ${label} di luar [0,1]` };
      }
    }
    const total = new Decimal(output.regime.supportive)
      .plus(output.regime.neutral)
      .plus(output.regime.hostile);
    if (total.lessThanOrEqualTo(0)) {
      return { ok: false, evaluation: null, reasonCode: "JEV_INVALID_OUTPUT", detail: "jumlah probabilitas regime nol" };
    }
  } else {
    if (output.probability === null || output.probability === undefined) {
      return { ok: false, evaluation: null, reasonCode: "JEV_INVALID_OUTPUT", detail: "probability wajib ada" };
    }
    if (!inUnitRange(output.probability)) {
      return { ok: false, evaluation: null, reasonCode: "JEV_INVALID_OUTPUT", detail: "probability di luar [0,1]" };
    }
  }
  if (output.confidence !== null && output.confidence !== undefined && !inUnitRange(output.confidence)) {
    return { ok: false, evaluation: null, reasonCode: "JEV_INVALID_OUTPUT", detail: "confidence di luar [0,1]" };
  }

  return {
    ok: true,
    reasonCode: "JEV_OK",
    detail: null,
    evaluation: {
      evaluator: output.evaluator,
      evaluatorVersion: output.evaluatorVersion,
      schemaVersion: output.schemaVersion,
      probability: output.probability ?? null,
      regime: output.regime ?? null,
      confidence: output.confidence ?? null,
      reasonCodes: [...output.reasonCodes],
      modelMetadata: { ...output.modelMetadata },
      status: "success",
    },
  };
}
