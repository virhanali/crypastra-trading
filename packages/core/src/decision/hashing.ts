import { fingerprint } from "../exchange/canonical.js";
import type { Decision, TradePlan } from "./types.js";

/**
 * Hashing riset keputusan (Phase 10).
 *
 * Memuat hanya field yang bermakna ekonomi/analitik. TIDAK memuat: id baris DB,
 * timestamp jam dinding, UUID, atau id acak. Dua evaluasi identik atas input
 * identik menghasilkan `decisionHash` identik.
 */

function planProjection(plan: TradePlan): Record<string, unknown> {
  return {
    contract: plan.contract,
    side: plan.side,
    orderType: plan.orderType,
    size: plan.size,
    leverage: plan.leverage,
    referencePrice: plan.referencePrice,
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
    notional: plan.notional,
    initialMargin: plan.initialMargin,
    riskAmount: plan.riskAmount,
    riskPercent: plan.riskPercent,
    rewardAmount: plan.rewardAmount,
    rewardRiskRatio: plan.rewardRiskRatio,
    sourceSignal: plan.sourceSignal,
    stopDistance: plan.stopDistance,
    stopDistancePct: plan.stopDistancePct,
  };
}

export function decisionHash(decision: Decision): string {
  return fingerprint(
    JSON.stringify({
      contract: decision.contract,
      timeframe: decision.timeframe,
      candleCloseTimeMs: decision.candleCloseTimeMs,
      accountId: decision.accountId,
      decisionVersion: decision.decisionVersion,
      featureVersion: decision.featureVersion,
      scannerVersion: decision.scannerVersion,
      scannerConfigHash: decision.scannerConfigHash,
      riskPolicyVersion: decision.riskPolicyVersion,
      riskPolicyHash: decision.riskPolicyHash,
      action: decision.action,
      direction: decision.direction,
      reasons: decision.reasons,
      tradePlan: decision.tradePlan === null ? null : planProjection(decision.tradePlan),
    }),
  );
}

export interface DecisionDigest {
  readonly evaluated: number;
  readonly approved: number;
  readonly skipped: number;
  readonly combinedHash: string;
  readonly reasonCodeCounts: Readonly<Record<string, number>>;
}

/** Sidik jari gabungan deret keputusan; dipakai uji determinisme replay. */
export function buildDecisionDigest(decisions: readonly Decision[]): DecisionDigest {
  const hashes = decisions.map(decisionHash);
  const reasonCodeCounts: Record<string, number> = {};
  let approved = 0;
  for (const decision of decisions) {
    if (decision.action === "trade") {
      approved += 1;
    }
    for (const code of decision.reasons) {
      reasonCodeCounts[code] = (reasonCodeCounts[code] ?? 0) + 1;
    }
  }
  return {
    evaluated: decisions.length,
    approved,
    skipped: decisions.length - approved,
    combinedHash: fingerprint(JSON.stringify({ hashes, reasonCodeCounts })),
    reasonCodeCounts,
  };
}
