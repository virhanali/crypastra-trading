import {
  assertObservationsAreStrings,
  observationsFromEvent,
  shouldRecordObservation,
  type MarketEvent,
  type MarketObservation,
  type ObservationKind,
} from "@crypastra/core";
import { MarketObservationRepository, RecordingSessionRepository } from "../repositories/market-observation-repository.js";

/**
 * Perekam pasar (Phase 8).
 *
 * Dipasang di BATAS TERNORMALISASI: yang direkam adalah observasi hasil
 * normalisasi, bukan paket mentah Gate. Observasi yang dikonsumsi live adalah
 * observasi yang sama yang disimpan untuk replay — jadi replay tidak pernah
 * mem-parse payload Gate lagi (ADR 0011).
 *
 * Saat TIDAK ada sesi aktif, perekam tidak menulis apa pun: perilaku persistensi
 * Phase 6 tidak berubah (hanya candle tertutup yang tersimpan).
 */
export interface MarketRecorderMetrics {
  readonly observationsWritten: number;
  readonly observationsSkippedUnchanged: number;
  readonly observationsDeduplicated: number;
  readonly byKind: Record<string, number>;
}

export class MarketRecorder {
  readonly #sessions: RecordingSessionRepository;
  readonly #observations: MarketObservationRepository;
  #activeSessionId: string | null = null;
  /** Observasi terakhir per (contract, kind) untuk kebijakan volume. */
  readonly #lastByKey = new Map<string, MarketObservation>();
  readonly #metrics = {
    observationsWritten: 0,
    observationsSkippedUnchanged: 0,
    observationsDeduplicated: 0,
    byKind: {} as Record<string, number>,
  };

  constructor(deps: {
    sessions: RecordingSessionRepository;
    observations: MarketObservationRepository;
  }) {
    this.#sessions = deps.sessions;
    this.#observations = deps.observations;
  }

  /** Sesi yang sedang direkam, atau null bila perekaman mati. */
  activeSessionId(): string | null {
    return this.#activeSessionId;
  }

  isRecording(): boolean {
    return this.#activeSessionId !== null;
  }

  startSession(input: {
    source: string;
    contracts: readonly string[];
    startedAtMs: number;
    metadata?: Record<string, unknown>;
  }): string {
    const session = this.#sessions.start(input);
    this.#activeSessionId = session.id;
    this.#lastByKey.clear();
    return session.id;
  }

  stopSession(endedAtMs: number, status: "completed" | "aborted" = "completed"): void {
    if (this.#activeSessionId === null) {
      return;
    }
    this.#sessions.stop(this.#activeSessionId, endedAtMs, status);
    this.#activeSessionId = null;
    this.#lastByKey.clear();
  }

  metrics(): MarketRecorderMetrics {
    return { ...this.#metrics, byKind: { ...this.#metrics.byKind } };
  }

  /**
   * Terima event pasar ternormalisasi. Tidak melakukan apa pun bila tidak ada
   * sesi aktif.
   */
  onEvent(event: MarketEvent, nowMs: number): void {
    const sessionId = this.#activeSessionId;
    if (sessionId === null) {
      return;
    }
    for (const observation of observationsFromEvent(event, nowMs)) {
      this.record(sessionId, observation, nowMs);
    }
  }

  /** Tulis satu observasi dengan kebijakan volume + dedupe. */
  record(sessionId: string, observation: MarketObservation, nowMs: number): boolean {
    assertObservationsAreStrings(observation);
    const key = `${observation.contract}:${observation.kind}`;
    const previous = this.#lastByKey.get(key) ?? null;

    if (!shouldRecordObservation(observation, previous)) {
      this.#metrics.observationsSkippedUnchanged += 1;
      return false;
    }

    const result = this.#observations.append({
      sessionId,
      observation,
      createdAtMs: nowMs,
    });
    if (result.duplicate) {
      this.#metrics.observationsDeduplicated += 1;
      return false;
    }

    this.#lastByKey.set(key, observation);
    this.#metrics.observationsWritten += 1;
    this.#metrics.byKind[observation.kind] = (this.#metrics.byKind[observation.kind] ?? 0) + 1;
    return true;
  }
}

/** Ringkasan jenis observasi yang direkam, untuk dokumentasi/observability. */
export function recordedKinds(): readonly ObservationKind[] {
  return ["mark", "quote", "funding", "candle"];
}
