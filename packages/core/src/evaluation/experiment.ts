import { fingerprint } from "../exchange/canonical.js";

/**
 * Identitas eksperimen baseline (Phase 11).
 *
 * Deskriptor deterministik supaya hasil dapat dibandingkan jujur. Nanti, ketika
 * Jev menjadi TREATMENT, satu-satunya perbedaan yang boleh ada adalah
 * konfigurasi perlakuan intelijen — bukan versi/konfigurasi tersembunyi.
 */
export const EXECUTION_VERSION = "execution-v1";

export interface BaselineExperiment {
  readonly recordingSession: string;
  readonly startingAccountState: string;
  readonly featureVersion: string;
  readonly scannerVersion: string;
  readonly scannerConfigHash: string;
  readonly decisionVersion: string;
  readonly riskPolicyHash: string;
  readonly executionVersion: string;
  readonly evaluationVersion: string;
  /** "on" | "off" — eksperimen eksekusi otonom atau observasi saja. */
  readonly execution: string;
}

export function experimentHash(experiment: BaselineExperiment): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(experiment).sort()) {
    ordered[key] = (experiment as unknown as Record<string, unknown>)[key];
  }
  return fingerprint(JSON.stringify(ordered));
}
