import { Decimal } from "../money.js";
import { fingerprint } from "../exchange/canonical.js";
import type { Candle } from "../market.js";
import type { Direction } from "../exchange/types.js";

/**
 * Pelabelan hasil (OFFLINE, Phase 13) — `outcome-label-v1`.
 *
 * Label adalah HASIL MASA DEPAN dari pasar setelah kandidat lahir. Label TIDAK
 * PERNAH dikirim ke Jev dan tidak boleh dibaca jalur keputusan/eksekusi hidup.
 * Definisi di bawah ini FIXED: tidak ada ambang yang disetel dari hasil Jev.
 */

export const OUTCOME_LABEL_VERSION = "outcome-label-v1";

/** Horizon riset (candle). Konstanta berversi, bukan hasil optimasi. */
export const LABEL_HORIZONS: readonly number[] = [1, 3, 6, 12];

/** Ambang target tren: |return berarah| minimum, dalam persen. */
export const TREND_TARGET_THRESHOLD_PCT = "0.25";
/** Momentum bertahan: ekskursi adverse maksimum, dalam kelipatan ATR. */
export const MOMENTUM_ADVERSE_LIMIT_ATR = "1";
/** Reversal material: ekskursi adverse minimum, dalam kelipatan ATR. */
export const REVERSAL_ATR_MULTIPLIER = "1.5";

export type LabelStatus = "complete" | "incomplete";
/** Satu sumber harga saja, didokumentasikan, tidak dicampur diam-diam. */
export type LabelPriceSource = "candle_ohlc";

export interface HorizonLabel {
  readonly horizon: number;
  /** Return berarah: LONG (fut−ref)/ref, SHORT (ref−fut)/ref. */
  readonly directionalReturn: string | null;
  /** Maximum Favorable Excursion berarah (satuan harga, ≥ 0). */
  readonly mfe: string | null;
  /** Maximum Adverse Excursion berarah (satuan harga, ≥ 0). */
  readonly mae: string | null;
  /** 1 bila directionalReturn ≥ ambang. */
  readonly trendTarget: 0 | 1 | null;
  /** 1 bila return positif DAN MAE ≤ ATR × limit. */
  readonly momentumTarget: 0 | 1 | null;
  /** 1 bila MAE ≥ ATR × multiplier (reversal material). */
  readonly reversalTarget: 0 | 1 | null;
}

export interface CandidateOutcomeLabel {
  readonly inputHash: string;
  readonly contract: string;
  readonly timeframe: string;
  readonly candleCloseTimeMs: number;
  readonly direction: Direction;
  readonly labelVersion: string;
  readonly horizons: readonly number[];
  readonly priceSource: LabelPriceSource;
  readonly referenceClose: string;
  readonly atr14: string | null;
  readonly horizonLabels: readonly HorizonLabel[];
  readonly status: LabelStatus;
  /** Alasan bila tidak lengkap; tidak pernah dipotong diam-diam. */
  readonly incompleteReason: string | null;
}

export interface BuildLabelInput {
  readonly inputHash: string;
  readonly contract: string;
  readonly timeframe: string;
  readonly candleCloseTimeMs: number;
  readonly direction: Direction;
  readonly referenceClose: string;
  readonly atr14: string | null;
  /** Candle SETELAH T, urut naik berdasarkan open time. */
  readonly futureCandles: readonly Candle[];
  readonly horizons?: readonly number[];
}

/**
 * Bangun label hasil untuk satu kandidat.
 *
 * Sumber harga: OHLC candle (`candle_ohlc`) — deterministik dan tersedia di
 * rekaman. Mark tidak dipakai supaya tidak mencampur sumber harga.
 */
export function buildCandidateOutcomeLabel(input: BuildLabelInput): CandidateOutcomeLabel {
  const horizons = input.horizons ?? LABEL_HORIZONS;
  const reference = new Decimal(input.referenceClose);
  const atr = input.atr14 === null ? null : new Decimal(input.atr14);
  const atrUsable = atr !== null && atr.isFinite() && atr.greaterThan(0);
  const threshold = new Decimal(TREND_TARGET_THRESHOLD_PCT).div(100);
  const adverseLimit = atrUsable ? atr!.times(MOMENTUM_ADVERSE_LIMIT_ATR) : null;
  const reversalLevel = atrUsable ? atr!.times(REVERSAL_ATR_MULTIPLIER) : null;

  const labels: HorizonLabel[] = [];
  let incompleteReason: string | null = null;

  for (const horizon of horizons) {
    if (input.futureCandles.length < horizon) {
      labels.push({
        horizon,
        directionalReturn: null,
        mfe: null,
        mae: null,
        trendTarget: null,
        momentumTarget: null,
        reversalTarget: null,
      });
      incompleteReason = incompleteReason ?? `riwayat masa depan kurang dari ${horizon} candle`;
      continue;
    }

    const window = input.futureCandles.slice(0, horizon);
    const futureClose = new Decimal(window[window.length - 1]!.c);
    const directionalReturn =
      input.direction === "long"
        ? futureClose.minus(reference).div(reference)
        : reference.minus(futureClose).div(reference);

    let mfe = new Decimal(0);
    let mae = new Decimal(0);
    for (const candle of window) {
      const high = new Decimal(candle.h);
      const low = new Decimal(candle.l);
      const favorable = input.direction === "long" ? high.minus(reference) : reference.minus(low);
      const adverse = input.direction === "long" ? reference.minus(low) : high.minus(reference);
      if (favorable.greaterThan(mfe)) mfe = favorable;
      if (adverse.greaterThan(mae)) mae = adverse;
    }
    if (mfe.isNegative()) mfe = new Decimal(0);
    if (mae.isNegative()) mae = new Decimal(0);

    labels.push({
      horizon,
      directionalReturn: directionalReturn.toString(),
      mfe: mfe.toString(),
      mae: mae.toString(),
      trendTarget: directionalReturn.greaterThanOrEqualTo(threshold) ? 1 : 0,
      momentumTarget:
        adverseLimit === null
          ? null
          : directionalReturn.greaterThan(0) && mae.lessThanOrEqualTo(adverseLimit)
            ? 1
            : 0,
      reversalTarget:
        reversalLevel === null ? null : mae.greaterThanOrEqualTo(reversalLevel) ? 1 : 0,
    });
  }

  return {
    inputHash: input.inputHash,
    contract: input.contract,
    timeframe: input.timeframe,
    candleCloseTimeMs: input.candleCloseTimeMs,
    direction: input.direction,
    labelVersion: OUTCOME_LABEL_VERSION,
    horizons,
    priceSource: "candle_ohlc",
    referenceClose: reference.toString(),
    atr14: input.atr14,
    horizonLabels: labels,
    status: incompleteReason === null ? "complete" : "incomplete",
    incompleteReason,
  };
}

/** Sidik jari satu label (bebas id DB/jam dinding). */
export function outcomeLabelHash(label: CandidateOutcomeLabel): string {
  return fingerprint(
    JSON.stringify({
      inputHash: label.inputHash,
      contract: label.contract,
      timeframe: label.timeframe,
      candleCloseTimeMs: label.candleCloseTimeMs,
      direction: label.direction,
      labelVersion: label.labelVersion,
      horizons: label.horizons,
      priceSource: label.priceSource,
      referenceClose: label.referenceClose,
      atr14: label.atr14,
      horizonLabels: label.horizonLabels,
      status: label.status,
    }),
  );
}
