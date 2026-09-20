import {
  OUTCOME_LABEL_VERSION,
  buildCandidateOutcomeLabel,
  type Candle,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { CandidateOutcomeLabelRepository } from "../repositories/candidate-outcome-label-repository.js";
import { FeatureSnapshotRepository } from "../repositories/feature-snapshot-repository.js";
import { ScannerResultRepository } from "../repositories/scanner-result-repository.js";
import { MarketObservationRepository } from "../repositories/market-observation-repository.js";
import { jevInputHash, buildJevInput, type BtcContext } from "@crypastra/core";

export interface LabelSessionResult {
  readonly candidates: number;
  readonly labeled: number;
  readonly incomplete: number;
  readonly alreadyLabeled: number;
}

/**
 * OutcomeLabeler (Phase 13) — OFFLINE.
 *
 * Menurunkan label hasil masa depan untuk setiap kandidat scanner pada sebuah
 * rekaman. Jalur ini hanya dipakai riset: ia MEMBACA masa depan, jadi ia tidak
 * boleh dan tidak dapat dipanggil dari perlakuan/keputusan/eksekusi hidup.
 */
export class OutcomeLabeler {
  readonly #connection: DatabaseConnection;
  readonly #labels: CandidateOutcomeLabelRepository;
  readonly #snapshots: FeatureSnapshotRepository;
  readonly #scanner: ScannerResultRepository;
  readonly #observations: MarketObservationRepository;

  constructor(connection: DatabaseConnection) {
    this.#connection = connection;
    this.#labels = new CandidateOutcomeLabelRepository(connection);
    this.#snapshots = new FeatureSnapshotRepository(connection);
    this.#scanner = new ScannerResultRepository(connection);
    this.#observations = new MarketObservationRepository(connection);
  }

  /** Label seluruh kandidat pada sesi. Idempoten per (inputHash, labelVersion). */
  labelSession(sessionId: string, options: { nowMs?: number } = {}): LabelSessionResult {
    const rows = this.#observations.list(sessionId, { limit: 1_000_000 });
    const candlesByContract = new Map<string, Candle[]>();
    for (const row of rows) {
      const observation = row.observation;
      if (observation.kind !== "candle" || !observation.closed) continue;
      const list = candlesByContract.get(observation.contract) ?? [];
      list.push({
        contract: observation.contract,
        interval: observation.interval,
        openTimeSeconds: observation.openTimeSeconds,
        o: observation.open,
        h: observation.high,
        l: observation.low,
        c: observation.close,
        v: observation.volume,
        sum: "0",
        windowClosed: true,
      });
      candlesByContract.set(observation.contract, list);
    }
    for (const list of candlesByContract.values()) {
      list.sort((a, b) => a.openTimeSeconds - b.openTimeSeconds);
    }

    const snapshots = this.#snapshots.list({ interval: "5m" });
    const btcSnapshots = snapshots.filter((row) => row.contract === "BTC_USDT").sort((a, b) => a.t - b.t);
    const candidates = this.#scanner
      .list({ interval: "5m" })
      .filter((row) => row.result.status === "candidate" && row.result.signal !== "neutral");

    let labeled = 0;
    let incomplete = 0;
    let alreadyLabeled = 0;

    for (const candidate of candidates) {
      const signal = candidate.result.signal;
      if (signal !== "long" && signal !== "short") continue;
      const feature = snapshots.find(
        (row) => row.contract === candidate.contract && row.t === candidate.result.candleCloseTimeMs - 300_000,
      );
      if (feature === undefined) continue;
      const btcRow = [...btcSnapshots].reverse().find((row) => row.t <= feature.t);
      const btcContext: BtcContext | null =
        candidate.contract === "BTC_USDT" || btcRow === undefined
          ? null
          : {
              contract: "BTC_USDT",
              trendStructure: btcRow.features.trendStructure,
              return1: btcRow.features.return1,
              return12: btcRow.features.return12,
              atrPercent: btcRow.features.atrPercent,
              close: btcRow.features.close,
            };
      const jevInput = buildJevInput({
        features: feature.features,
        scanner: candidate.result,
        btcContext,
        direction: signal,
      });
      const hash = jevInputHash(jevInput);
      if (this.#labels.find(hash, OUTCOME_LABEL_VERSION) !== null) {
        alreadyLabeled += 1;
        continue;
      }

      const contractCandles = candlesByContract.get(candidate.contract) ?? [];
      const futureCandles = contractCandles.filter(
        (candle) => candle.openTimeSeconds * 1000 >= candidate.result.candleCloseTimeMs,
      );
      const label = buildCandidateOutcomeLabel({
        inputHash: hash,
        contract: candidate.contract,
        timeframe: candidate.result.timeframe,
        candleCloseTimeMs: candidate.result.candleCloseTimeMs,
        direction: signal,
        referenceClose: feature.features.close,
        atr14: feature.features.atr14,
        futureCandles,
      });
      this.#labels.insertIfAbsent(label, options.nowMs ?? 0);
      if (label.status === "complete") labeled += 1;
      else incomplete += 1;
    }

    return { candidates: candidates.length, labeled, incomplete, alreadyLabeled };
  }
}
