import {
  DATASET_VERSION,
  OUTCOME_LABEL_VERSION,
  type BtcContext,
  type DatasetEvaluation,
  type DatasetRow,
  buildJevInput,
  jevInputHash,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { CandidateOutcomeLabelRepository } from "../repositories/candidate-outcome-label-repository.js";
import { FeatureSnapshotRepository } from "../repositories/feature-snapshot-repository.js";
import { ScannerResultRepository } from "../repositories/scanner-result-repository.js";
import { JevEvaluationRepository } from "../repositories/jev-evaluation-repository.js";
import { TreatmentResultRepository } from "../repositories/treatment-result-repository.js";
import { MarketObservationRepository } from "../repositories/market-observation-repository.js";

export interface DatasetBuildResult {
  readonly rows: DatasetRow[];
  readonly candidates: number;
  readonly missingSnapshots: number;
}

/**
 * DatasetBuilder (Phase 13) — menyatukan kandidat + probabilitas Jev + hasil
 * perlakuan + label masa depan menjadi baris riset.
 *
 * HANYA data pasar/riset. Tidak ada accountId, wallet, saldo, margin, ledger,
 * API key, atau id implementasi DB.
 */
export class DatasetBuilder {
  readonly #snapshots: FeatureSnapshotRepository;
  readonly #scanner: ScannerResultRepository;
  readonly #jev: JevEvaluationRepository;
  readonly #treatments: TreatmentResultRepository;
  readonly #labels: CandidateOutcomeLabelRepository;
  readonly #observations: MarketObservationRepository;

  constructor(connection: DatabaseConnection) {
    this.#snapshots = new FeatureSnapshotRepository(connection);
    this.#scanner = new ScannerResultRepository(connection);
    this.#jev = new JevEvaluationRepository(connection);
    this.#treatments = new TreatmentResultRepository(connection);
    this.#labels = new CandidateOutcomeLabelRepository(connection);
    this.#observations = new MarketObservationRepository(connection);
  }

  build(sessionId: string): DatasetBuildResult {
    const observations = this.#observations.list(sessionId, { limit: 1_000_000 });
    const sessionContracts = new Set(observations.map((row) => row.observation.contract));

    const snapshots = this.#snapshots.list({ interval: "5m" }).filter((row) => sessionContracts.has(row.contract));
    const btcSnapshots = snapshots.filter((row) => row.contract === "BTC_USDT").sort((a, b) => a.t - b.t);
    const scannerRows = this.#scanner
      .list({ interval: "5m" })
      .filter((row) => sessionContracts.has(row.contract) && row.result.status === "candidate" && row.result.signal !== "neutral");
    const treatments = new Map(
      this.#treatments.list().map((row) => [`${row.contract}:${row.candleCloseTimeMs}:${row.direction}`, row]),
    );

    const rows: DatasetRow[] = [];
    let missingSnapshots = 0;

    for (const scannerRow of scannerRows) {
      const signal = scannerRow.result.signal;
      if (signal !== "long" && signal !== "short") continue;
      const feature = snapshots.find(
        (row) => row.contract === scannerRow.contract && row.t === scannerRow.result.candleCloseTimeMs - 300_000,
      );
      if (feature === undefined) {
        missingSnapshots += 1;
        continue;
      }
      const btcRow = [...btcSnapshots].reverse().find((row) => row.t <= feature.t);
      const btcContext: BtcContext | null =
        scannerRow.contract === "BTC_USDT" || btcRow === undefined
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
        scanner: scannerRow.result,
        btcContext,
        direction: signal,
      });
      const inputHash = jevInputHash(jevInput);

      const evaluations: DatasetEvaluation[] = this.#jev
        .list({ contract: scannerRow.contract, limit: 100_000 })
        .filter((row) => row.inputHash === inputHash)
        .map((row) => ({
          evaluator: row.evaluator,
          status: row.status,
          probability: row.probability,
          regime: null,
          evaluatorVersion: "",
          promptVersion: "",
          schemaVersion: "",
          provider: "",
          model: "",
        }));

      const treatment = treatments.get(`${scannerRow.contract}:${scannerRow.result.candleCloseTimeMs}:${signal}`) ?? null;
      rows.push({
        datasetVersion: DATASET_VERSION,
        sessionId,
        contract: scannerRow.contract,
        timeframe: scannerRow.result.timeframe,
        candleCloseTimeMs: scannerRow.result.candleCloseTimeMs,
        direction: signal,
        featureVersion: feature.features.featureVersion,
        scannerVersion: scannerRow.result.scannerVersion,
        scannerConfigHash: scannerRow.result.scannerConfigHash,
        jevInputHash: inputHash,
        evaluations,
        candidateStatus: evaluations.length >= 3 ? "complete" : evaluations.length === 0 ? "missing" : "partial",
        treatmentStatus: treatment?.status ?? null,
        treatmentReasons: treatment?.reasons ?? [],
        labels: this.#labels.find(inputHash, OUTCOME_LABEL_VERSION),
      });
    }

    return { rows, candidates: scannerRows.length, missingSnapshots };
  }
}
