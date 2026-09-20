import { fingerprint } from "../exchange/canonical.js";
import type { CandidateOutcomeLabel } from "./outcome-label.js";

/**
 * Baris dataset riset (Phase 13) — gabungan konteks kandidat, probabilitas Jev,
 * hasil perlakuan, dan label masa depan.
 *
 * HANYA data pasar/riset. DILARANG memuat: accountId, wallet, saldo, margin,
 * ledger, API key, atau id implementasi DB.
 */
export const DATASET_VERSION = "dataset-v1";

export interface DatasetEvaluation {
  readonly evaluator: string;
  readonly status: string;
  readonly probability: string | null;
  readonly regime: { supportive: string; neutral: string; hostile: string } | null;
  readonly evaluatorVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly provider: string;
  readonly model: string;
}

export interface DatasetRow {
  readonly datasetVersion: string;
  readonly sessionId: string;
  readonly contract: string;
  readonly timeframe: string;
  readonly candleCloseTimeMs: number;
  readonly direction: string;
  readonly featureVersion: string;
  readonly scannerVersion: string;
  readonly scannerConfigHash: string;
  readonly jevInputHash: string;
  readonly evaluations: readonly DatasetEvaluation[];
  readonly candidateStatus: string;
  readonly treatmentStatus: string | null;
  readonly treatmentReasons: readonly string[];
  readonly labels: CandidateOutcomeLabel | null;
}

/** Urutan kanonik: (session, candleCloseTime, contract, direction). */
export function canonicalDatasetOrder(rows: readonly DatasetRow[]): DatasetRow[] {
  return [...rows].sort(
    (a, b) =>
      a.sessionId.localeCompare(b.sessionId) ||
      a.candleCloseTimeMs - b.candleCloseTimeMs ||
      a.contract.localeCompare(b.contract) ||
      a.direction.localeCompare(b.direction),
  );
}

export function datasetRowHash(row: DatasetRow): string {
  return fingerprint(JSON.stringify(row));
}

export interface DatasetDigest {
  readonly rowCount: number;
  readonly combinedHash: string;
  readonly contractDistribution: Readonly<Record<string, number>>;
  readonly directionDistribution: Readonly<Record<string, number>>;
  readonly treatmentDistribution: Readonly<Record<string, number>>;
  readonly labelStatusDistribution: Readonly<Record<string, number>>;
}

/**
 * Sidik jari deterministik seluruh dataset.
 *
 * Dua ekspor dari rekaman + evaluasi Jev + versi label yang sama menghasilkan
 * `combinedHash` identik. Tidak memuat id DB atau jam dinding.
 */
export function buildDatasetDigest(rows: readonly DatasetRow[]): DatasetDigest {
  const ordered = canonicalDatasetOrder(rows);
  const contractDistribution: Record<string, number> = {};
  const directionDistribution: Record<string, number> = {};
  const treatmentDistribution: Record<string, number> = {};
  const labelStatusDistribution: Record<string, number> = {};
  for (const row of ordered) {
    contractDistribution[row.contract] = (contractDistribution[row.contract] ?? 0) + 1;
    directionDistribution[row.direction] = (directionDistribution[row.direction] ?? 0) + 1;
    const treatment = row.treatmentStatus ?? "none";
    treatmentDistribution[treatment] = (treatmentDistribution[treatment] ?? 0) + 1;
    const labelStatus = row.labels?.status ?? "missing";
    labelStatusDistribution[labelStatus] = (labelStatusDistribution[labelStatus] ?? 0) + 1;
  }
  return {
    rowCount: ordered.length,
    combinedHash: fingerprint(JSON.stringify(ordered.map(datasetRowHash))),
    contractDistribution,
    directionDistribution,
    treatmentDistribution,
    labelStatusDistribution,
  };
}

/** Serialisasi JSONL kanonik (satu baris per kandidat, urut kanonik). */
export function datasetToJsonl(rows: readonly DatasetRow[]): string {
  return canonicalDatasetOrder(rows)
    .map((row) => JSON.stringify(row))
    .join("\n");
}
