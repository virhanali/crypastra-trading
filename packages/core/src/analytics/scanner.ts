import { z } from "zod";
import { Decimal } from "../money.js";
import type { FeatureSnapshot } from "./features.js";

/**
 * Hard Scanner deterministik (Phase 9).
 *
 * Tujuan: mempersempit universe menjadi setup yang layak ditinjau. Keluaran
 * HANYA informasi pasar/setup — tidak ada ukuran posisi, leverage, SL/TP, atau
 * saldo. Ambang batas hidup di config yang bisa diserialisasi dan di-hash.
 *
 * Scanner tidak menghasilkan sinyal per-tick. Hanya dipanggil saat candle 5m
 * TERTUTUP menghasilkan FeatureSnapshot dengan warmup selesai.
 */

export const SCANNER_VERSION = "scanner-v1";

export const ScannerConfigSchema = z.object({
  minVolumeRatio: z.string().default("1.0"),
  minAtrPercent: z.string().default("0.2"),
  maxAtrPercent: z.string().default("5.0"),
  rsiLongMin: z.string().default("50"),
  rsiLongMax: z.string().default("70"),
  rsiShortMin: z.string().default("30"),
  rsiShortMax: z.string().default("50"),
  maxDistanceFromEma20: z.string().default("3.0"),
  requireTrendAlignment: z.boolean().default(true),
  useBtcContext: z.boolean().default(false),
  requireBtcAlignment: z.boolean().default(false),
  minimumHistory: z.number().int().positive().default(200),
});

export type ScannerConfig = z.infer<typeof ScannerConfigSchema>;

/**
 * Default konservatif V1. Tidak dioptimasi terhadap sampel Phase 8 (§33).
 * minAtrPercent 0.2% menyaring pasar yang terlalu mati; maxAtrPercent 5%
 * menyaring volatilitas ekstrem; maxDistanceFromEma20 3% menandai overextended.
 */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = ScannerConfigSchema.parse({});

export type ReasonCode =
  | "WARMUP_INCOMPLETE"
  | "INSUFFICIENT_HISTORY"
  | "TREND_BULLISH"
  | "TREND_BEARISH"
  | "TREND_MIXED"
  | "TREND_NOT_ALIGNED"
  | "MACD_POSITIVE"
  | "MACD_NEGATIVE"
  | "RSI_LONG_RANGE"
  | "RSI_SHORT_RANGE"
  | "RSI_OUT_OF_RANGE"
  | "VOLUME_CONFIRMED"
  | "VOLUME_TOO_LOW"
  | "VOLATILITY_OK"
  | "VOLATILITY_TOO_LOW"
  | "VOLATILITY_TOO_HIGH"
  | "OVEREXTENDED"
  | "MOMENTUM_LONG"
  | "MOMENTUM_SHORT"
  | "MOMENTUM_NEUTRAL"
  | "BTC_CONTEXT_MISSING"
  | "BTC_CONTEXT_CONFLICT"
  | "BTC_CONTEXT_ALIGNED";

export type ScannerDirection = "long" | "short" | "neutral";
export type ScannerStatus = "candidate" | "skip";
export type SetupType =
  | "trend_continuation_long"
  | "trend_continuation_short"
  | "none";

/** Konteks BTC deterministik untuk kontrak non-BTC. */
export interface BtcContext {
  readonly contract: string;
  readonly trendStructure: string | null;
  readonly return1: string | null;
  readonly return12: string | null;
  readonly atrPercent: string | null;
  readonly close: string;
}

export interface ScannerResult {
  readonly contract: string;
  readonly timeframe: string;
  readonly candleCloseTimeMs: number;
  readonly featureVersion: string;
  readonly scannerVersion: string;
  readonly scannerConfigHash: string;
  readonly status: ScannerStatus;
  readonly direction: ScannerDirection;
  readonly setupType: SetupType;
  readonly facts: {
    readonly trendAligned: boolean;
    readonly momentumAligned: boolean;
    readonly volatilityAcceptable: boolean;
    readonly volumeConfirmed: boolean;
    readonly overextended: boolean;
    readonly rsiInRange: boolean;
  };
  readonly reasonCodes: readonly ReasonCode[];
  /** Sinyal baseline deterministik: LONG/SHORT/NEUTRAL. */
  readonly signal: ScannerDirection;
}

function dec(value: string | null): Decimal | null {
  return value === null ? null : new Decimal(value);
}

/** Fakta BTC yang diekspos apa adanya ke konteks scanner. */
export function btcContextFromBtcFeatures(features: FeatureSnapshot): BtcContext {
  return {
    contract: features.contract,
    trendStructure: features.trendStructure,
    return1: features.return1,
    return12: features.return12,
    atrPercent: features.atrPercent,
    close: features.close,
  };
}

/**
 * Pindai satu FeatureSnapshot.
 *
 * Deterministik penuh: keluaran hanya fungsi dari (fitur, config, konteks BTC).
 */
export function scan(
  features: FeatureSnapshot,
  config: ScannerConfig = DEFAULT_SCANNER_CONFIG,
  configHash = "",
  btcContext: BtcContext | null = null,
): ScannerResult {
  const reasons: ReasonCode[] = [];

  const minVolumeRatio = new Decimal(config.minVolumeRatio);
  const minAtrPercent = new Decimal(config.minAtrPercent);
  const maxAtrPercent = new Decimal(config.maxAtrPercent);
  const rsiLongMin = new Decimal(config.rsiLongMin);
  const rsiLongMax = new Decimal(config.rsiLongMax);
  const rsiShortMin = new Decimal(config.rsiShortMin);
  const rsiShortMax = new Decimal(config.rsiShortMax);
  const maxDistance = new Decimal(config.maxDistanceFromEma20);

  const empty = (status: ScannerStatus, extra: readonly ReasonCode[]): ScannerResult => ({
    contract: features.contract,
    timeframe: features.timeframe,
    candleCloseTimeMs: features.candleCloseTimeMs,
    featureVersion: features.featureVersion,
    scannerVersion: SCANNER_VERSION,
    scannerConfigHash: configHash,
    status,
    direction: "neutral",
    setupType: "none",
    facts: {
      trendAligned: false,
      momentumAligned: false,
      volatilityAcceptable: false,
      volumeConfirmed: false,
      overextended: false,
      rsiInRange: false,
    },
    reasonCodes: extra,
    signal: "neutral",
  });

  if (!features.warmupComplete) {
    return empty("skip", ["WARMUP_INCOMPLETE"]);
  }
  if (features.candleCount < config.minimumHistory) {
    return empty("skip", ["INSUFFICIENT_HISTORY"]);
  }

  const trend = features.trendStructure;
  if (trend === "bullish") reasons.push("TREND_BULLISH");
  else if (trend === "bearish") reasons.push("TREND_BEARISH");
  else reasons.push("TREND_MIXED");

  const histogram = dec(features.macdHistogram);
  const rsi = dec(features.rsi14);
  const atrPercent = dec(features.atrPercent);
  const volumeRatio = dec(features.volumeRatio);
  const distanceEma20 = dec(features.distanceEma20Pct);

  const trendAligned = trend === "bullish" || trend === "bearish";
  const overextended = distanceEma20 !== null && distanceEma20.abs().greaterThan(maxDistance);
  const volatilityTooLow = atrPercent === null || atrPercent.lessThan(minAtrPercent);
  const volatilityTooHigh = atrPercent !== null && atrPercent.greaterThan(maxAtrPercent);
  const volatilityAcceptable = !volatilityTooLow && !volatilityTooHigh;
  const volumeConfirmed = volumeRatio !== null && volumeRatio.greaterThanOrEqualTo(minVolumeRatio);

  if (volumeConfirmed) reasons.push("VOLUME_CONFIRMED");
  else reasons.push("VOLUME_TOO_LOW");
  if (volatilityAcceptable) reasons.push("VOLATILITY_OK");
  else if (volatilityTooLow) reasons.push("VOLATILITY_TOO_LOW");
  else reasons.push("VOLATILITY_TOO_HIGH");
  if (overextended) reasons.push("OVEREXTENDED");
  if (config.requireTrendAlignment && !trendAligned) reasons.push("TREND_NOT_ALIGNED");

  let momentumAligned = false;
  if (histogram !== null) {
    if (histogram.greaterThan(0)) {
      momentumAligned = true;
      reasons.push("MACD_POSITIVE");
    } else {
      reasons.push("MACD_NEGATIVE");
    }
  }

  const rsiLongOk = rsi !== null && rsi.greaterThanOrEqualTo(rsiLongMin) && rsi.lessThanOrEqualTo(rsiLongMax);
  const rsiShortOk = rsi !== null && rsi.greaterThanOrEqualTo(rsiShortMin) && rsi.lessThanOrEqualTo(rsiShortMax);
  if (rsiLongOk) reasons.push("RSI_LONG_RANGE");
  else if (rsiShortOk) reasons.push("RSI_SHORT_RANGE");
  else reasons.push("RSI_OUT_OF_RANGE");

  // ── Kandidat: setup yang layak dievaluasi (belum sinyal) ──────
  const longCandidate = trend === "bullish" && (!config.requireTrendAlignment || trendAligned);
  const shortCandidate = trend === "bearish" && (!config.requireTrendAlignment || trendAligned);
  let direction: ScannerDirection = "neutral";
  let setupType: SetupType = "none";
  if (longCandidate) {
    direction = "long";
    setupType = "trend_continuation_long";
  } else if (shortCandidate) {
    direction = "short";
    setupType = "trend_continuation_short";
  }

  // ── Sinyal baseline: konfluensi penuh ─────────────────────────
  const baseLong =
    direction === "long" &&
    momentumAligned &&
    rsiLongOk &&
    volumeConfirmed &&
    volatilityAcceptable &&
    !overextended;
  const baseShort =
    direction === "short" &&
    histogram !== null &&
    histogram.lessThan(0) &&
    rsiShortOk &&
    volumeConfirmed &&
    volatilityAcceptable &&
    !overextended;

  let signal: ScannerDirection = baseLong ? "long" : baseShort ? "short" : "neutral";

  if (config.useBtcContext) {
    if (btcContext === null) {
      reasons.push("BTC_CONTEXT_MISSING");
      if (config.requireBtcAlignment) signal = "neutral";
    } else if (config.requireBtcAlignment && signal !== "neutral" && btcContext.trendStructure !== null) {
      const aligned =
        (signal === "long" && btcContext.trendStructure === "bullish") ||
        (signal === "short" && btcContext.trendStructure === "bearish");
      if (aligned) reasons.push("BTC_CONTEXT_ALIGNED");
      else {
        reasons.push("BTC_CONTEXT_CONFLICT");
        signal = "neutral";
      }
    }
  }

  if (signal === "long") reasons.push("MOMENTUM_LONG");
  else if (signal === "short") reasons.push("MOMENTUM_SHORT");
  else if (signal === "neutral" && direction !== "neutral") reasons.push("MOMENTUM_NEUTRAL");

  const status: ScannerStatus = signal !== "neutral" ? "candidate" : "skip";

  return {
    contract: features.contract,
    timeframe: features.timeframe,
    candleCloseTimeMs: features.candleCloseTimeMs,
    featureVersion: features.featureVersion,
    scannerVersion: SCANNER_VERSION,
    scannerConfigHash: configHash,
    status,
    direction,
    setupType,
    facts: {
      trendAligned,
      momentumAligned,
      volatilityAcceptable,
      volumeConfirmed,
      overextended,
      rsiInRange: rsiLongOk || rsiShortOk,
    },
    reasonCodes: reasons,
    signal,
  };
}
