import type { ExitReason, TradeRecord } from "@crypastra/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { tradeRecords } from "../db/schema.js";

/**
 * TradeRecordRepository — materialisasi riset (Phase 11). DERIVED: sumber
 * kebenaran ekonomi tetap orders/fills/positions/ledger; baris di sini boleh
 * dibangun ulang dan tidak dipakai logika ekonomi apa pun.
 */
export class TradeRecordRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  /** Sisipkan bila belum ada; false bila trade untuk keputusan itu sudah ada. */
  insertIfAbsent(record: TradeRecord, createdAtMs: number): boolean {
    const inserted = this.#conn.db
      .insert(tradeRecords)
      .values({
        tradeId: record.tradeId,
        accountId: record.accountId,
        decisionId: record.decisionId,
        contract: record.contract,
        side: record.side,
        decisionTime: record.decisionTimeMs,
        entryTime: record.entryTimeMs,
        exitTime: record.exitTimeMs,
        plannedReference: record.plannedReference,
        actualEntry: record.actualEntry,
        size: record.size,
        leverage: record.leverage,
        stopLoss: record.stopLoss,
        takeProfit: record.takeProfit,
        plannedRisk: record.plannedRiskAmount,
        actualInitialRisk: record.actualInitialRiskAmount,
        grossRealizedPnl: record.grossRealizedPnl,
        fees: record.fees,
        funding: record.funding,
        netPnl: record.netPnl,
        exitReason: record.exitReason,
        mae: record.mae,
        mfe: record.mfe,
        maeR: record.maeR,
        mfeR: record.mfeR,
        rMultiple: record.rMultiple,
        holdingDuration: record.holdingDurationMs,
        featureVersion: record.featureVersion,
        scannerVersion: record.scannerVersion,
        scannerConfigHash: record.scannerConfigHash,
        decisionVersion: record.decisionVersion,
        riskPolicyVersion: record.riskPolicyVersion,
        riskPolicyHash: record.riskPolicyHash,
        evaluationVersion: record.evaluationVersion,
        createdAt: createdAtMs,
      })
      .onConflictDoNothing()
      .returning({ tradeId: tradeRecords.tradeId })
      .all();
    return inserted.length > 0;
  }

  update(record: TradeRecord, nowMs: number): void {
    this.#conn.db
      .update(tradeRecords)
      .set({
        exitTime: record.exitTimeMs,
        actualEntry: record.actualEntry,
        grossRealizedPnl: record.grossRealizedPnl,
        fees: record.fees,
        funding: record.funding,
        netPnl: record.netPnl,
        exitReason: record.exitReason,
        mae: record.mae,
        mfe: record.mfe,
        maeR: record.maeR,
        mfeR: record.mfeR,
        rMultiple: record.rMultiple,
        holdingDuration: record.holdingDurationMs,
        actualInitialRisk: record.actualInitialRiskAmount,
      })
      .where(eq(tradeRecords.tradeId, record.tradeId))
      .run();
    void nowMs;
  }

  find(tradeId: string): TradeRecord | null {
    const row = this.#conn.db.select().from(tradeRecords).where(eq(tradeRecords.tradeId, tradeId)).get();
    return row === undefined ? null : mapRow(row);
  }

  list(filter: { accountId?: string; contract?: string; limit?: number } = {}): TradeRecord[] {
    const where = [
      ...(filter.accountId === undefined ? [] : [eq(tradeRecords.accountId, filter.accountId)]),
      ...(filter.contract === undefined ? [] : [eq(tradeRecords.contract, filter.contract)]),
    ];
    return this.#conn.db
      .select()
      .from(tradeRecords)
      .where(where.length === 0 ? undefined : and(...where))
      .orderBy(asc(tradeRecords.entryTime), asc(tradeRecords.tradeId))
      .limit(filter.limit ?? 100_000)
      .all()
      .map(mapRow);
  }

  count(): number {
    const row = this.#conn.db.select({ n: sql<number>`count(*)` }).from(tradeRecords).get();
    return row?.n ?? 0;
  }
}

function mapRow(row: typeof tradeRecords.$inferSelect): TradeRecord {
  return {
    tradeId: row.tradeId,
    accountId: row.accountId,
    decisionId: row.decisionId,
    contract: row.contract,
    side: row.side as TradeRecord["side"],
    decisionTimeMs: row.decisionTime,
    entryTimeMs: row.entryTime,
    exitTimeMs: row.exitTime,
    plannedReference: row.plannedReference,
    actualEntry: row.actualEntry,
    size: row.size,
    leverage: row.leverage,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    plannedRiskAmount: row.plannedRisk,
    actualInitialRiskAmount: row.actualInitialRisk,
    grossRealizedPnl: row.grossRealizedPnl,
    fees: row.fees,
    funding: row.funding,
    netPnl: row.netPnl,
    exitReason: row.exitReason as ExitReason,
    mae: row.mae,
    mfe: row.mfe,
    maeR: row.maeR,
    mfeR: row.mfeR,
    rMultiple: row.rMultiple,
    holdingDurationMs: row.holdingDuration,
    featureVersion: row.featureVersion,
    scannerVersion: row.scannerVersion,
    scannerConfigHash: row.scannerConfigHash,
    decisionVersion: row.decisionVersion,
    riskPolicyVersion: row.riskPolicyVersion,
    riskPolicyHash: row.riskPolicyHash,
    evaluationVersion: row.evaluationVersion,
  };
}
