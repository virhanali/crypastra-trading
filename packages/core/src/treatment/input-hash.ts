import { fingerprint } from "../exchange/canonical.js";
import type { JevInput } from "./types.js";

/**
 * Bidang yang ikut di-hash. Sengaja eksplisit supaya bidang baru tidak
 * diam-diam mengubah identitas cache.
 *
 * TIDAK memuat: jam dinding, id baris DB, UUID acak, atau keadaan akun.
 */
const HASHED_FIELDS = [
  "contract",
  "timeframe",
  "candleCloseTimeMs",
  "direction",
  "close",
  "ema20",
  "ema50",
  "ema200",
  "distanceEma20Pct",
  "distanceEma50Pct",
  "distanceEma200Pct",
  "rsi14",
  "macd",
  "macdSignal",
  "macdHistogram",
  "atr14",
  "atrPercent",
  "return1",
  "return3",
  "return12",
  "volumeRatio",
  "trendStructure",
  "scannerStatus",
  "scannerSetupType",
  "scannerReasonCodes",
  "scannerFacts",
  "btc",
  "featureVersion",
  "scannerVersion",
  "scannerConfigHash",
] as const;

/**
 * `jevInputHash` — identitas kanonik input Jev.
 *
 * Keadaan pasar/scanner yang sama → hash yang sama. Dipakai sebagai identitas
 * cache dan bukti bahwa tidak ada informasi akun/masa depan yang bocor ke Jev.
 */
export function jevInputHash(input: JevInput): string {
  const projected: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) {
    projected[field] = (input as unknown as Record<string, unknown>)[field];
  }
  return fingerprint(JSON.stringify(projected));
}
