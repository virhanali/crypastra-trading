import type { EvaluatorName, EvaluatorEvaluation, JevInput } from "./types.js";

// Port tidak pernah tahu HTTP/SDK/kredensial; implementasi ada di adapters.

/**
 * Port komunikasi Jev (Phase 12).
 *
 * Inti HANYA mendefinisikan kontrak; ia tidak tahu HTTP, SDK, kredensial,
 * retry, atau jaringan. Implementasi konkret hidup di `@crypastra/adapters`.
 */

export interface JevEvaluationRequest {
  readonly input: JevInput;
  readonly inputHash: string;
  readonly evaluator: EvaluatorName;
  readonly evaluatorVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
}

export interface JevEvaluationResponse {
  readonly evaluation: EvaluatorEvaluation;
  /** Metadata operasional; TIDAK masuk hash perlakuan. */
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface JevEvaluatorPort {
  /** Identitas provider/model; bagian dari identitas cache. */
  readonly provider: string;
  readonly model: string;
  evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResponse>;
}

/** Hasil tersimpan untuk satu identitas cache. */
export interface StoredJevEvaluation {
  readonly evaluation: EvaluatorEvaluation;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * Penyimpanan evaluasi Jev (cache + audit). Diimplementasikan lapisan server
 * dengan DB; inti tetap bebas DB.
 */
export interface JevEvaluationStore {
  find(identity: {
    inputHash: string;
    evaluator: EvaluatorName;
    evaluatorVersion: string;
    promptVersion: string;
    schemaVersion: string;
    provider: string;
    model: string;
  }): StoredJevEvaluation | null;
  save(input: {
    input: JevInput;
    inputHash: string;
    evaluator: EvaluatorName;
    identity: {
      evaluatorVersion: string;
      promptVersion: string;
      schemaVersion: string;
      provider: string;
      model: string;
    };
    evaluation: EvaluatorEvaluation;
    latencyMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    createdAtMs: number;
  }): void;
}

export interface JevUsageCounters {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  successes: number;
  invalid: number;
  unavailable: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}
