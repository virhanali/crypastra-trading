import { fingerprint } from "../exchange/canonical.js";
import type { FeatureSnapshot } from "./features.js";
import { ScannerConfigSchema, type ScannerConfig, type ScannerResult } from "./scanner.js";

/**
 * Hashing riset deterministik.
 *
 * Hash harus IDENTIK untuk dua replay dari rekaman yang sama. Karena itu hash
 * TIDAK memuat: row id DB, timestamp wall-clock, UUID, atau id acak. Yang
 * dimuat hanya nilai ekonomi/analitik yang bisa direproduksi. Memakai
 * `fingerprint` FNV-1a dari exchange/canonical.ts agar inti tetap tanpa
 * ketergantungan kripto (aman untuk bundel web).
 */

export function scannerConfigHash(config: ScannerConfig): string {
  const parsed = ScannerConfigSchema.parse(config);
  // Kunci diurutkan supaya urutan literal objek tidak mengubah hash.
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parsed).sort()) {
    ordered[key] = (parsed as Record<string, unknown>)[key];
  }
  return fingerprint(JSON.stringify(ordered));
}

const FEATURE_HASH_FIELDS = [
  "contract",
  "timeframe",
  "featureVersion",
  "candleCloseTimeMs",
  "close",
  "ema20",
  "ema50",
  "ema200",
  "rsi14",
  "macd",
  "macdSignal",
  "macdHistogram",
  "atr14",
  "atrPercent",
  "return1",
  "return3",
  "return12",
  "volume",
  "volumeMa20",
  "volumeRatio",
  "distanceEma20Pct",
  "distanceEma50Pct",
  "distanceEma200Pct",
  "trendStructure",
  "warmupComplete",
] as const;

export function featureSnapshotHash(snapshot: FeatureSnapshot): string {
  const projected: Record<string, unknown> = {};
  for (const field of FEATURE_HASH_FIELDS) {
    projected[field] = (snapshot as unknown as Record<string, unknown>)[field];
  }
  return fingerprint(JSON.stringify(projected));
}

export function scannerResultHash(result: ScannerResult): string {
  return fingerprint(
    JSON.stringify({
      contract: result.contract,
      timeframe: result.timeframe,
      candleCloseTimeMs: result.candleCloseTimeMs,
      featureVersion: result.featureVersion,
      scannerVersion: result.scannerVersion,
      scannerConfigHash: result.scannerConfigHash,
      status: result.status,
      direction: result.direction,
      setupType: result.setupType,
      facts: result.facts,
      reasonCodes: result.reasonCodes,
      signal: result.signal,
    }),
  );
}

/**
 * Hash kanonik gabungan untuk satu sesi riset.
 *
 * Dua replay dengan input sama WAJIB menghasilkan `combinedHash` yang sama.
 */
export interface ResearchDigest {
  readonly snapshotCount: number;
  readonly resultCount: number;
  readonly combinedHash: string;
  readonly reasonCodeCounts: Readonly<Record<string, number>>;
  readonly counters: Readonly<Record<string, number>>;
}

export function buildResearchDigest(input: {
  readonly snapshots: readonly FeatureSnapshot[];
  readonly results: readonly ScannerResult[];
  readonly counters: Readonly<Record<string, number>>;
}): ResearchDigest {
  const featureHashes = input.snapshots.map(featureSnapshotHash);
  const resultHashes = input.results.map(scannerResultHash);
  const reasonCodeCounts: Record<string, number> = {};
  for (const result of input.results) {
    for (const code of result.reasonCodes) {
      reasonCodeCounts[code] = (reasonCodeCounts[code] ?? 0) + 1;
    }
  }
  const combinedHash = fingerprint(JSON.stringify({ featureHashes, resultHashes, reasonCodeCounts }));
  return {
    snapshotCount: input.snapshots.length,
    resultCount: input.results.length,
    combinedHash,
    reasonCodeCounts,
    counters: input.counters,
  };
}
