import { decodeContractSize } from "@crypastra/core";
import type { Decision, DecisionReasonCode, Direction, TradePlan } from "@crypastra/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { decisions } from "../db/schema.js";

export interface DecisionRecord {
  readonly id: string;
  readonly decision: Decision;
  readonly createdAt: number;
}

/**
 * DecisionRepository — keputusan otonom Phase 10 (termasuk SKIP).
 *
 * SKIP ikut dipersist: evaluasi masa depan perlu tahu peluang apa yang DITOLAK
 * dan alasannya, bukan hanya rencana yang disetujui.
 *
 * Idempoten per (account, contract, interval, candle_close_t, decision_version,
 * scanner_version, scanner_config_hash, risk_policy_hash). Id diturunkan
 * deterministik dari kunci itu — tanpa UUID acak (§22).
 *
 * Lapisan ini TIDAK menyentuh orders/fills/positions/ledger.
 */
export class DecisionRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  static idFor(input: {
    accountId: string;
    contract: string;
    interval: string;
    candleCloseT: number;
    decisionVersion: string;
    scannerVersion: string;
    scannerConfigHash: string;
    riskPolicyHash: string;
  }): string {
    return [
      "dec",
      input.accountId,
      input.contract,
      input.interval,
      String(input.candleCloseT),
      input.decisionVersion,
      input.scannerVersion,
      input.scannerConfigHash,
      input.riskPolicyHash,
    ].join(":");
  }

  /** Identitas deterministik sebuah Decision (dipakai eksekusi & linkage). */
  static decisionIdFor(decision: Decision): string {
    return DecisionRepository.idFor({
      accountId: decision.accountId,
      contract: decision.contract,
      interval: decision.timeframe,
      candleCloseT: decision.candleCloseTimeMs,
      decisionVersion: decision.decisionVersion,
      scannerVersion: decision.scannerVersion,
      scannerConfigHash: decision.scannerConfigHash,
      riskPolicyHash: decision.riskPolicyHash,
    });
  }

  /** Kembalikan true bila baris baru disisipkan (false = duplikat idempoten). */
  insertIfAbsent(input: {
    decision: Decision;
    riskJson: string;
    createdAtMs: number;
  }): boolean {
    const { decision } = input;
    const plan = decision.tradePlan;
    const inserted = this.#conn.db
      .insert(decisions)
      .values({
        id: DecisionRepository.idFor({
          accountId: decision.accountId,
          contract: decision.contract,
          interval: decision.timeframe,
          candleCloseT: decision.candleCloseTimeMs,
          decisionVersion: decision.decisionVersion,
          scannerVersion: decision.scannerVersion,
          scannerConfigHash: decision.scannerConfigHash,
          riskPolicyHash: decision.riskPolicyHash,
        }),
        accountId: decision.accountId,
        contract: decision.contract,
        interval: decision.timeframe,
        candleCloseT: decision.candleCloseTimeMs,
        action: decision.action,
        direction: decision.direction,
        sizeText: plan === null ? null : String(plan.size),
        leverage: plan?.leverage ?? null,
        referencePrice: plan?.referencePrice ?? null,
        tpPrice: plan?.takeProfit ?? null,
        slPrice: plan?.stopLoss ?? null,
        notional: plan?.notional ?? null,
        initialMargin: plan?.initialMargin ?? null,
        riskAmount: plan?.riskAmount ?? null,
        riskPercent: plan?.riskPercent ?? null,
        rewardAmount: plan?.rewardAmount ?? null,
        rewardRiskRatio: plan?.rewardRiskRatio ?? null,
        stopDistance: plan?.stopDistance ?? null,
        stopDistancePct: plan?.stopDistancePct ?? null,
        reasonsJson: JSON.stringify(decision.reasons),
        riskJson: input.riskJson,
        jevEvaluationId: null,
        decisionVersion: decision.decisionVersion,
        featureVersion: decision.featureVersion,
        scannerVersion: decision.scannerVersion,
        scannerConfigHash: decision.scannerConfigHash,
        riskPolicyVersion: decision.riskPolicyVersion,
        riskPolicyHash: decision.riskPolicyHash,
        createdAt: input.createdAtMs,
      })
      .onConflictDoNothing()
      .returning({ id: decisions.id })
      .all();
    return inserted.length > 0;
  }

  list(
    filter: { accountId?: string; contract?: string; limit?: number } = {},
  ): DecisionRecord[] {
    const where = [
      ...(filter.accountId === undefined ? [] : [eq(decisions.accountId, filter.accountId)]),
      ...(filter.contract === undefined ? [] : [eq(decisions.contract, filter.contract)]),
    ];
    return this.#conn.db
      .select()
      .from(decisions)
      .where(where.length === 0 ? undefined : and(...where))
      .orderBy(asc(decisions.candleCloseT), asc(decisions.contract))
      .limit(filter.limit ?? 100_000)
      .all()
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        decision: {
          contract: row.contract,
          timeframe: row.interval,
          candleCloseTimeMs: row.candleCloseT,
          accountId: row.accountId,
          decisionVersion: row.decisionVersion,
          featureVersion: row.featureVersion,
          scannerVersion: row.scannerVersion,
          scannerConfigHash: row.scannerConfigHash,
          riskPolicyVersion: row.riskPolicyVersion,
          riskPolicyHash: row.riskPolicyHash,
          action: row.action as Decision["action"],
          direction: row.direction as Direction | null,
          reasons: JSON.parse(row.reasonsJson) as DecisionReasonCode[],
          tradePlan: row.sizeText === null ? null : (tradePlanFromRow(row) as TradePlan),
        },
      }));
  }

  count(): number {
    const row = this.#conn.db
      .select({ n: sql<number>`count(*)` })
      .from(decisions)
      .get();
    return row?.n ?? 0;
  }
}

function tradePlanFromRow(row: {
  contract: string;
  direction: Direction | null;
  sizeText: string | null;
  leverage: string | null;
  referencePrice: string | null;
  tpPrice: string | null;
  slPrice: string | null;
  notional: string | null;
  initialMargin: string | null;
  riskAmount: string | null;
  riskPercent: string | null;
  rewardAmount: string | null;
  rewardRiskRatio: string | null;
  stopDistance: string | null;
  stopDistancePct: string | null;
}): TradePlan {
  return {
    contract: row.contract,
    side: row.direction as Direction,
    orderType: "market",
    size: decodeContractSize(row.sizeText ?? "0"),
    leverage: row.leverage ?? "0",
    referencePrice: row.referencePrice ?? "0",
    stopLoss: row.slPrice ?? "0",
    takeProfit: row.tpPrice ?? "0",
    notional: row.notional ?? "0",
    initialMargin: row.initialMargin ?? "0",
    riskAmount: row.riskAmount ?? "0",
    riskPercent: row.riskPercent ?? "0",
    rewardAmount: row.rewardAmount ?? "0",
    rewardRiskRatio: row.rewardRiskRatio ?? "0",
    sourceSignal: (row.direction ?? "long") as Direction,
    stopDistance: row.stopDistance ?? "0",
    stopDistancePct: row.stopDistancePct ?? "0",
  };
}
