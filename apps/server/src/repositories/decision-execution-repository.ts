import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { decisionExecutions } from "../db/schema.js";

export type ExecutionStatus =
  | "pending"
  | "submitted"
  | "filled"
  | "resting"
  | "rejected"
  | "failed"
  | "skipped";

export interface DecisionExecutionRecord {
  readonly id: string;
  readonly decisionId: string;
  readonly accountId: string;
  readonly commandId: string;
  readonly orderId: string | null;
  readonly positionId: string | null;
  readonly status: ExecutionStatus;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly plannedReference: string | null;
  readonly actualFillPrice: string | null;
  readonly attemptedAt: number;
  readonly updatedAt: number;
}

/** Status terminal: percobaan ulang tidak boleh menambah ekonomi baru. */
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = [
  "filled",
  "resting",
  "rejected",
  "failed",
  "skipped",
];

/**
 * DecisionExecutionRepository — linkage eksekusi otonom (Phase 11).
 *
 * Unik per `decision_id`, sehingga satu keputusan disetujui menghasilkan paling
 * banyak satu entry. Bukan tabel ekonomi: tidak menyimpan ulang order/fill.
 */
export class DecisionExecutionRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  static idFor(decisionId: string): string {
    return `exec:${decisionId}`;
  }

  findByDecision(decisionId: string): DecisionExecutionRecord | null {
    const row = this.#conn.db
      .select()
      .from(decisionExecutions)
      .where(eq(decisionExecutions.decisionId, decisionId))
      .get();
    return row === undefined ? null : mapRow(row);
  }

  /** Sisipkan baris `pending`; false bila sudah ada (idempoten). */
  begin(input: {
    decisionId: string;
    accountId: string;
    commandId: string;
    plannedReference: string | null;
    nowMs: number;
  }): boolean {
    const inserted = this.#conn.db
      .insert(decisionExecutions)
      .values({
        id: DecisionExecutionRepository.idFor(input.decisionId),
        decisionId: input.decisionId,
        accountId: input.accountId,
        commandId: input.commandId,
        orderId: null,
        positionId: null,
        status: "pending",
        errorCode: null,
        errorDetail: null,
        plannedReference: input.plannedReference,
        actualFillPrice: null,
        attemptedAt: input.nowMs,
        updatedAt: input.nowMs,
      })
      .onConflictDoNothing()
      .returning({ id: decisionExecutions.id })
      .all();
    return inserted.length > 0;
  }

  update(input: {
    decisionId: string;
    status: ExecutionStatus;
    orderId?: string | null;
    positionId?: string | null;
    errorCode?: string | null;
    errorDetail?: string | null;
    actualFillPrice?: string | null;
    nowMs: number;
  }): void {
    this.#conn.db
      .update(decisionExecutions)
      .set({
        status: input.status,
        ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
        ...(input.positionId === undefined ? {} : { positionId: input.positionId }),
        errorCode: input.errorCode ?? null,
        errorDetail: input.errorDetail ?? null,
        ...(input.actualFillPrice === undefined ? {} : { actualFillPrice: input.actualFillPrice }),
        updatedAt: input.nowMs,
      })
      .where(eq(decisionExecutions.decisionId, input.decisionId))
      .run();
  }

  list(filter: { accountId?: string; status?: ExecutionStatus; limit?: number } = {}): DecisionExecutionRecord[] {
    const where = [
      ...(filter.accountId === undefined ? [] : [eq(decisionExecutions.accountId, filter.accountId)]),
      ...(filter.status === undefined ? [] : [eq(decisionExecutions.status, filter.status)]),
    ];
    return this.#conn.db
      .select()
      .from(decisionExecutions)
      .where(where.length === 0 ? undefined : and(...where))
      .orderBy(asc(decisionExecutions.attemptedAt), asc(decisionExecutions.decisionId))
      .limit(filter.limit ?? 100_000)
      .all()
      .map(mapRow);
  }

  count(): number {
    const row = this.#conn.db
      .select({ n: sql<number>`count(*)` })
      .from(decisionExecutions)
      .get();
    return row?.n ?? 0;
  }
}

function mapRow(row: typeof decisionExecutions.$inferSelect): DecisionExecutionRecord {
  return {
    id: row.id,
    decisionId: row.decisionId,
    accountId: row.accountId,
    commandId: row.commandId,
    orderId: row.orderId,
    positionId: row.positionId,
    status: row.status as ExecutionStatus,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    plannedReference: row.plannedReference,
    actualFillPrice: row.actualFillPrice,
    attemptedAt: row.attemptedAt,
    updatedAt: row.updatedAt,
  };
}
