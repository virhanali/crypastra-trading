import type {
  EvaluatorEvaluation,
  EvaluatorName,
  JevEvaluationStore,
  JevInput,
  StoredJevEvaluation,
} from "@crypastra/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { jevEvaluations } from "../db/schema.js";

export interface JevEvaluationRecord {
  readonly id: string;
  readonly inputHash: string;
  readonly contract: string;
  readonly t: number;
  readonly direction: string;
  readonly evaluator: string;
  readonly status: string;
  readonly probability: string | null;
  readonly createdAt: number;
}

/**
 * JevEvaluationRepository — persistensi + CACHE evaluasi Jev (Phase 12).
 *
 * Mengimplementasikan `JevEvaluationStore` sehingga `JevTreatment` (inti) tetap
 * bebas DB. Idempoten lewat unique index identitas cache.
 */
export class JevEvaluationRepository implements JevEvaluationStore {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  find(identity: {
    inputHash: string;
    evaluator: EvaluatorName;
    evaluatorVersion: string;
    promptVersion: string;
    schemaVersion: string;
    provider: string;
    model: string;
  }): StoredJevEvaluation | null {
    const row = this.#conn.db
      .select()
      .from(jevEvaluations)
      .where(
        and(
          eq(jevEvaluations.inputHash, identity.inputHash),
          eq(jevEvaluations.evaluator, identity.evaluator),
          eq(jevEvaluations.evaluatorVersion, identity.evaluatorVersion),
          eq(jevEvaluations.promptVersion, identity.promptVersion),
          eq(jevEvaluations.schemaVersion, identity.schemaVersion),
          eq(jevEvaluations.provider, identity.provider),
          eq(jevEvaluations.model, identity.model),
        ),
      )
      .get();
    if (row === undefined) {
      return null;
    }
    return {
      evaluation: JSON.parse(row.outputJson) as EvaluatorEvaluation,
      latencyMs: row.latencyMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    };
  }

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
  }): void {
    const id = [
      "jev",
      input.inputHash,
      input.evaluator,
      input.identity.evaluatorVersion,
      input.identity.promptVersion,
      input.identity.schemaVersion,
      input.identity.provider,
      input.identity.model,
    ].join(":");
    this.#conn.db
      .insert(jevEvaluations)
      .values({
        id,
        inputHash: input.inputHash,
        contract: input.input.contract,
        interval: input.input.timeframe,
        t: input.input.candleCloseTimeMs,
        direction: input.input.direction,
        evaluator: input.evaluator,
        evaluatorVersion: input.identity.evaluatorVersion,
        promptVersion: input.identity.promptVersion,
        schemaVersion: input.identity.schemaVersion,
        provider: input.identity.provider,
        model: input.identity.model,
        probability: input.evaluation.probability,
        regimeJson: input.evaluation.regime === null ? null : JSON.stringify(input.evaluation.regime),
        confidence: input.evaluation.confidence,
        status: input.evaluation.status,
        reasonCodesJson: JSON.stringify(input.evaluation.reasonCodes),
        outputJson: JSON.stringify(input.evaluation),
        metadataJson: JSON.stringify(input.evaluation.modelMetadata),
        inputsJson: JSON.stringify(input.input),
        latencyMs: input.latencyMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        createdAt: input.createdAtMs,
      })
      .onConflictDoNothing()
      .run();
  }

  list(filter: { contract?: string; limit?: number } = {}): JevEvaluationRecord[] {
    const where = filter.contract === undefined ? undefined : eq(jevEvaluations.contract, filter.contract);
    return this.#conn.db
      .select()
      .from(jevEvaluations)
      .where(where)
      .orderBy(asc(jevEvaluations.t), asc(jevEvaluations.evaluator))
      .limit(filter.limit ?? 100_000)
      .all()
      .map((row) => ({
        id: row.id,
        inputHash: row.inputHash,
        contract: row.contract,
        t: row.t,
        direction: row.direction,
        evaluator: row.evaluator,
        status: row.status,
        probability: row.probability,
        createdAt: row.createdAt,
      }));
  }

  count(): number {
    const row = this.#conn.db.select({ n: sql<number>`count(*)` }).from(jevEvaluations).get();
    return row?.n ?? 0;
  }
}
