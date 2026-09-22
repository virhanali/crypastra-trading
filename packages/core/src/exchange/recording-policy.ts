/**
 * Kebijakan perekaman berversi (Phase 13.1).
 *
 * - FULL: perilaku lama — mark selalu, quote tiap berubah, candle tertutup,
 *   funding tiap berubah. Semantik dan hash replay TIDAK berubah.
 * - RESEARCH_COMPACT: turunan hemat untuk perekaman 24/7 — SEMUA candle
 *   tertutup + funding yang dibutuhkan model riset/replay tetap tersimpan,
 *   tetapi quote/mark dibatasi paling banyak 1 observasi per detik per
 *   kontrak (coalescing deterministik: yang PERTAMA dalam tiap bucket detik
 *   waktu-sumber lolos). BUKAN replay tick-perfect; didokumentasikan.
 *
 * Tidak ada nilai pasar yang dikarang: coalescing hanya MEMBUANG observasi,
 * tidak pernah membuat/mengubah nilai.
 */

export type RecordingPolicyName = "full" | "research-compact";

export interface RecordingPolicy {
  readonly name: RecordingPolicyName;
  /** Versi skema kebijakan; naik bila semantik berubah. Terekam di metadata sesi. */
  readonly version: 1;
  /** Batas observasi per detik per kontrak (Infinity = tanpa batas). */
  readonly quotePerSecond: number;
  readonly markPerSecond: number;
}

export const RECORDING_POLICY_VERSION = 1 as const;

export const FULL_RECORDING_POLICY: RecordingPolicy = {
  name: "full",
  version: RECORDING_POLICY_VERSION,
  quotePerSecond: Number.POSITIVE_INFINITY,
  markPerSecond: Number.POSITIVE_INFINITY,
};

export const RESEARCH_COMPACT_POLICY_V1: RecordingPolicy = {
  name: "research-compact",
  version: RECORDING_POLICY_VERSION,
  quotePerSecond: 1,
  markPerSecond: 1,
};

/** Baca kebijakan dari env; default FULL (aman, perilaku lama). */
export function recordingPolicyFromEnv(
  env: Record<string, string | undefined> = {},
): RecordingPolicy {
  const raw = (env["CRYPASTRA_RECORDING_POLICY"] ?? "").trim().toLowerCase();
  if (raw === "research-compact" || raw === "research_compact" || raw === "compact") {
    return RESEARCH_COMPACT_POLICY_V1;
  }
  return FULL_RECORDING_POLICY;
}

/**
 * Bucket detik waktu-sumber untuk coalescing. Dua observasi dalam satu
 * kontrak+jenis dinyatakan "satu detik yang sama" bila floor(ts/1000) sama.
 * Deterministik terhadap urutan input yang sama; tidak memakai jam lokal.
 */
export function compactSecondBucket(sourceTimestampMs: number): number {
  return Math.floor(sourceTimestampMs / 1000);
}

// ─────────────────────────────────────────────────────────────
// Kesiapan gap-aware (EMA200 jujur)
// ─────────────────────────────────────────────────────────────

export interface CandleGapAnalysis {
  /** Jumlah candle tertutup unik (sesudah dedupe + sortir). */
  readonly closedCandles: number;
  /** Jumlah celah (rentang hilang) dalam deret. */
  readonly gapCount: number;
  /** Celah terbesar dalam satuan candle (0 bila tidak ada celah). */
  readonly largestGapCandles: number;
  /** openTime (detik) candle terakhir SEBELUM celah terakhir, null bila tak ada celah. */
  readonly lastGapAtSeconds: number | null;
  /** Deret candle tertutup BERURUTAN terpanjang di UJUNG (yang menentukan kesiapan). */
  readonly consecutiveTrailing: number;
  readonly ema200Ready: boolean;
}

/**
 * Analisis celah deret candle tertutup 5m (atau interval lain).
 *
 * Aturan riset: ema200Ready HANYA bila 200 candle terakhir BERURUTAN tanpa
 * celah. 200 candle dengan celah di tengah = NOT_READY. Tidak ada
 * interpolasi, tidak ada fabrikasi candle hilang.
 */
export function analyzeCandleGaps(
  openTimesSeconds: readonly number[],
  intervalSeconds: number,
): CandleGapAnalysis {
  const unique = [...new Set(openTimesSeconds)].sort((a, b) => a - b);
  if (unique.length === 0) {
    return {
      closedCandles: 0,
      gapCount: 0,
      largestGapCandles: 0,
      lastGapAtSeconds: null,
      consecutiveTrailing: 0,
      ema200Ready: false,
    };
  }
  let gapCount = 0;
  let largestGapCandles = 0;
  let lastGapAtSeconds: number | null = null;
  for (let i = 1; i < unique.length; i++) {
    const step = Math.round((unique[i]! - unique[i - 1]!) / intervalSeconds);
    if (step > 1) {
      gapCount += 1;
      largestGapCandles = Math.max(largestGapCandles, step - 1);
      lastGapAtSeconds = unique[i - 1]!;
    }
  }
  // Deret berurutan di ujung: jalan mundur selama selisih tepat 1 interval.
  let consecutiveTrailing = 1;
  for (let i = unique.length - 1; i > 0; i--) {
    if (Math.round((unique[i]! - unique[i - 1]!) / intervalSeconds) === 1) {
      consecutiveTrailing += 1;
    } else {
      break;
    }
  }
  return {
    closedCandles: unique.length,
    gapCount,
    largestGapCandles,
    lastGapAtSeconds,
    consecutiveTrailing,
    ema200Ready: consecutiveTrailing >= 200,
  };
}
