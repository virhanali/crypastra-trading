import { Decimal } from "../money.js";
import {
  assertValidLeverage,
  assertValidMultiplier,
  notionalValueFor,
} from "../exchange/contract-math.js";
import { floorToContractCount, floorToDecimalSize } from "../exchange/rounding.js";
import { initialMarginFor } from "../exchange/margin.js";
import { MONEY_DP } from "../money.js";
import { roundProtectivePrice } from "./tick-policy.js";
import { riskPolicyHash, RISK_POLICY_VERSION, type RiskPolicy } from "./risk-policy.js";
import { DECISION_VERSION, type Decision, type DecisionInput, type DecisionReasonCode, type TradePlan } from "./types.js";

/**
 * Decision + Risk Engine deterministik (Phase 10). MURNI.
 *
 * Menjawab: "haruskah kita trading setup ini?" dan, bila ya, "rencana paper apa
 * yang diizinkan?". TIDAK mengeksekusi: TradePlan tidak pernah dikirim ke
 * OrderService dari lapisan ini (§30).
 *
 * Urutan evaluasi (deterministik):
 *   sinyal → batas posisi → kutipan → ATR/stop → anggaran risiko → ukuran
 *   → cap notional/kontrak → leverage → margin → reward/risk.
 *
 * Setiap penolakan mengembalikan reason code mesin-baca; tidak ada prosa yang
 * perlu ditafsirkan.
 */
export function decide(input: DecisionInput): Decision {
  const { features, scanner, spec, market, account, policy } = input;
  const reasons: DecisionReasonCode[] = [];

  const base = {
    contract: input.contract,
    timeframe: input.timeframe,
    candleCloseTimeMs: input.candleCloseTimeMs,
    accountId: input.accountId,
    decisionVersion: DECISION_VERSION,
    featureVersion: features.featureVersion,
    scannerVersion: scanner.scannerVersion,
    scannerConfigHash: scanner.scannerConfigHash,
    riskPolicyVersion: RISK_POLICY_VERSION,
    riskPolicyHash: riskPolicyHash(policy),
  } as const;

  const skip = (): Decision => ({
    ...base,
    action: "skip",
    direction: null,
    reasons,
    tradePlan: null,
  });

  // ── 1. Sinyal ────────────────────────────────────────────────
  if (scanner.signal === "neutral") {
    reasons.push("SIGNAL_NEUTRAL");
    if (scanner.status === "skip") {
      reasons.push("SCANNER_SKIPPED");
      if (scanner.reasonCodes.includes("WARMUP_INCOMPLETE")) {
        reasons.push("WARMUP_INCOMPLETE");
      }
    }
    return skip();
  }
  const direction = scanner.signal;
  reasons.push(direction === "long" ? "SIGNAL_LONG" : "SIGNAL_SHORT");

  // ── 2. Batas posisi (keadaan akun, bukan matematika) ──────────
  const sameContract = account.openPositions.filter((p) => p.contract === input.contract);
  if (sameContract.length > 0) {
    // Baseline V1 tidak menaikkan, mengurangi, atau membalik posisi otomatis.
    reasons.push("EXISTING_CONTRACT_POSITION");
    return skip();
  }
  if (sameContract.length >= policy.maxPositionsPerContract) {
    reasons.push("CONTRACT_POSITION_LIMIT");
    return skip();
  }
  if (account.openPositionCount >= policy.maxOpenPositions) {
    reasons.push("MAX_OPEN_POSITIONS");
    return skip();
  }

  // ── 3. Harga acuan entry ─────────────────────────────────────
  // Mark adalah harga valuasi/trigger, bukan harga masuk yang diharapkan.
  const referenceRaw = direction === "long" ? market.bestAsk : market.bestBid;
  if (referenceRaw === null || referenceRaw === undefined) {
    reasons.push("QUOTE_UNAVAILABLE");
    return skip();
  }
  const reference = new Decimal(referenceRaw);
  if (!reference.isFinite() || reference.lessThanOrEqualTo(0)) {
    reasons.push("QUOTE_UNAVAILABLE");
    return skip();
  }

  // ── 4. Stop dari ATR ─────────────────────────────────────────
  const atrRaw = features.atr14;
  if (atrRaw === null) {
    reasons.push("ATR_UNAVAILABLE");
    return skip();
  }
  const atr = new Decimal(atrRaw);
  if (!atr.isFinite() || atr.lessThanOrEqualTo(0)) {
    reasons.push("ATR_UNAVAILABLE");
    return skip();
  }

  const atrMultiplier = new Decimal(policy.atrStopMultiplier);
  const plannedStopDistance = atr.times(atrMultiplier);
  if (plannedStopDistance.lessThanOrEqualTo(0)) {
    reasons.push("INVALID_STOP_DISTANCE");
    return skip();
  }
  const plannedStopDistancePct = plannedStopDistance.div(reference).times(100);
  const minStopPct = new Decimal(policy.minimumStopDistancePct);
  const maxStopPct = new Decimal(policy.maximumStopDistancePct);
  if (plannedStopDistancePct.lessThan(minStopPct)) {
    reasons.push("STOP_DISTANCE_TOO_TIGHT");
    return skip();
  }
  if (plannedStopDistancePct.greaterThan(maxStopPct)) {
    reasons.push("STOP_DISTANCE_TOO_WIDE");
    return skip();
  }

  // ── 5. Normalisasi harga protektif (tick, arah-sadar) ─────────
  const tick = spec.orderPriceRound;
  const rawStop =
    direction === "long"
      ? reference.minus(plannedStopDistance)
      : reference.plus(plannedStopDistance);
  const stopLoss = roundProtectivePrice(rawStop, "stop", direction, tick);

  // Jarak stop AKTUAL dipakai untuk sizing: pembulatan tidak boleh membuat
  // risiko melebihi rencana.
  const stopDistance =
    direction === "long" ? reference.minus(stopLoss) : stopLoss.minus(reference);
  if (!stopDistance.isFinite() || stopDistance.lessThanOrEqualTo(0)) {
    reasons.push("INVALID_STOP_DISTANCE");
    return skip();
  }

  // ── 6. Anggaran risiko ───────────────────────────────────────
  const equity = new Decimal(account.equity);
  const riskBudget = equity.times(new Decimal(policy.riskPerTradePct).div(100));
  if (riskBudget.lessThanOrEqualTo(0)) {
    reasons.push("RISK_BUDGET_TOO_SMALL");
    return skip();
  }
  const riskPerContract = assertValidMultiplier(spec).times(stopDistance);
  if (riskPerContract.lessThanOrEqualTo(0)) {
    reasons.push("INVALID_STOP_DISTANCE");
    return skip();
  }

  const rawSize = riskBudget.div(riskPerContract);
  if (rawSize.lessThanOrEqualTo(0)) {
    reasons.push("RISK_BUDGET_TOO_SMALL");
    return skip();
  }

  // ── 7. Normalisasi ukuran ────────────────────────────────────
  let size = normalizeSize(spec.enableDecimal, rawSize);
  // Hanya laporkan pembulatan bila ia benar-benar mengubah ukuran; reason code
  // yang selalu muncul tidak informatif.
  if (new Decimal(size).lessThan(rawSize)) {
    reasons.push(spec.enableDecimal ? "SIZE_DECIMAL_FLOORED" : "SIZE_FLOORED_INTEGER");
  }
  if (size <= 0 || size < spec.orderSizeMin) {
    reasons.push("SIZE_BELOW_MINIMUM");
    return skip();
  }
  if (size > spec.orderSizeMax) {
    size = spec.orderSizeMax;
    reasons.push("SIZE_CAPPED_CONTRACT_MAX");
  }

  // ── 8. Cap notional (risiko bisa kecil saat SL sangat rapat) ──
  const maxNotional = equity.times(new Decimal(policy.maxPositionNotionalPct).div(100));
  const perContractNotional = assertValidMultiplier(spec).times(reference);
  let notional = notionalValueFor(spec, size, reference);
  if (notional.greaterThan(maxNotional) && perContractNotional.greaterThan(0)) {
    const capped = maxNotional.div(perContractNotional);
    const cappedSize = normalizeSize(spec.enableDecimal, capped);
    if (cappedSize <= 0 || cappedSize < spec.orderSizeMin) {
      reasons.push("SIZE_CAPPED_NOTIONAL");
      return skip();
    }
    if (cappedSize < size) {
      size = cappedSize;
      reasons.push("SIZE_CAPPED_NOTIONAL");
      notional = notionalValueFor(spec, size, reference);
    }
  }

  // ── 9. Leverage ──────────────────────────────────────────────
  const leverage = selectLeverage(spec, policy);
  if (leverage === null) {
    reasons.push("LEVERAGE_UNAVAILABLE");
    return skip();
  }

  // ── 10. Margin ───────────────────────────────────────────────
  const margin = initialMarginFor({ spec, size, price: reference, leverage });
  const available = new Decimal(account.availableBalance);
  if (margin.greaterThan(available)) {
    reasons.push("INSUFFICIENT_AVAILABLE_BALANCE");
    return skip();
  }
  const projectedMargin = new Decimal(account.positionMargin)
    .plus(new Decimal(account.reservedMargin))
    .plus(margin);
  const maxTotalMargin = equity.times(new Decimal(policy.maxTotalMarginPct).div(100));
  if (projectedMargin.greaterThan(maxTotalMargin)) {
    reasons.push("TOTAL_MARGIN_LIMIT");
    return skip();
  }

  // ── 11. Reward / risk setelah pembulatan tick ────────────────
  const rewardDistance = stopDistance.times(new Decimal(policy.rewardRiskRatio));
  const rawTarget =
    direction === "long"
      ? reference.plus(rewardDistance)
      : reference.minus(rewardDistance);
  const takeProfit = roundProtectivePrice(rawTarget, "target", direction, tick);
  const actualRewardDistance =
    direction === "long" ? takeProfit.minus(reference) : reference.minus(takeProfit);
  if (actualRewardDistance.lessThanOrEqualTo(0)) {
    reasons.push("REWARD_RISK_TOO_LOW");
    return skip();
  }
  const rewardRiskRatio = actualRewardDistance.div(stopDistance);
  if (rewardRiskRatio.lessThan(new Decimal(policy.minimumRewardRiskRatio))) {
    reasons.push("REWARD_RISK_TOO_LOW");
    return skip();
  }

  // ── 12. Rencana akhir (dihitung dari nilai HASIL klamp) ──────
  const riskAmount = riskPerContract.times(size);
  const rewardPerContract = assertValidMultiplier(spec).times(actualRewardDistance);
  const rewardAmount = rewardPerContract.times(size);
  const riskPercent = equity.isZero() ? new Decimal(0) : riskAmount.div(equity).times(100);
  const stopDistancePct = stopDistance.div(reference).times(100);

  const tradePlan: TradePlan = {
    contract: input.contract,
    side: direction,
    orderType: "market",
    size,
    leverage: leverage.toString(),
    referencePrice: reference.toString(),
    stopLoss: stopLoss.toString(),
    takeProfit: takeProfit.toString(),
    notional: notional.toString(),
    initialMargin: margin.toString(),
    riskAmount: riskAmount.toString(),
    riskPercent: riskPercent.toString(),
    rewardAmount: rewardAmount.toString(),
    rewardRiskRatio: rewardRiskRatio.toString(),
    sourceSignal: direction,
    stopDistance: stopDistance.toString(),
    stopDistancePct: stopDistancePct.toString(),
  };

  reasons.push("TRADE_APPROVED");
  return {
    ...base,
    action: "trade",
    direction,
    reasons,
    tradePlan,
  };
}

function normalizeSize(enableDecimal: boolean, rawSize: Decimal): number {
  return enableDecimal ? floorToDecimalSize(rawSize, MONEY_DP) : floorToContractCount(rawSize);
}

/**
 * Leverage deterministik: default kebijakan, dijepit oleh batas kontrak dan
 * `maxLeverage`. TIDAK diturunkan dari keyakinan sinyal (dan nanti tidak
 * diturunkan dari keyakinan Jev).
 */
function selectLeverage(
  spec: DecisionInput["spec"],
  policy: RiskPolicy,
): Decimal | null {
  const lower = Decimal.max(spec.leverageMin, 1);
  const upper = Decimal.min(spec.leverageMax, new Decimal(policy.maxLeverage));
  if (lower.greaterThan(upper)) {
    return null;
  }
  const preferred = new Decimal(policy.defaultLeverage);
  const chosen = Decimal.min(Decimal.max(preferred, lower), upper);
  return assertValidLeverage(spec, chosen);
}
