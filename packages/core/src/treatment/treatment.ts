import {
  JEV_EVALUATOR_VERSION,
  JEV_PROMPT_VERSION,
  JEV_SCHEMA_VERSION,
  TREATMENT_VERSION,
  type CandidateTreatment,
  type EvaluatorEvaluation,
  type EvaluatorName,
  type JevInput,
  type TreatmentEvaluations,
  type TreatmentInput,
  type TreatmentResult,
} from "./types.js";
import type {
  JevEvaluationStore,
  JevEvaluatorPort,
  JevUsageCounters,
  StoredJevEvaluation,
} from "./port.js";
import { validateEvaluatorOutput } from "./output-schema.js";
import {
  DEFAULT_JEV_VETO_CONFIG,
  applyJevVetoPolicy,
  jevVetoConfigHash,
  type JevVetoConfig,
} from "./policy.js";

/** CONTROL: tidak ada perlakuan. Selalu ALLOW, tanpa panggilan eksternal. */
export class NoTreatment implements CandidateTreatment {
  readonly kind = "none";
  readonly version = "treatment-none-v1";
  readonly configHash = "none";

  evaluate(input: TreatmentInput): TreatmentResult {
    return {
      kind: this.kind,
      treatmentVersion: this.version,
      treatmentConfigHash: this.configHash,
      status: "allow",
      direction: input.direction,
      contract: input.input.contract,
      timeframe: input.input.timeframe,
      candleCloseTimeMs: input.input.candleCloseTimeMs,
      inputHash: input.inputHash,
      evaluations: emptyEvaluations(),
      reasons: ["TREATMENT_NONE"],
    };
  }
}

export interface JevTreatmentOptions {
  readonly store: JevEvaluationStore;
  readonly config?: JevVetoConfig;
  readonly evaluatorVersion?: string;
  readonly promptVersion?: string;
  readonly schemaVersion?: string;
  /** Identitas provider/model yang dipakai saat collect (bagian identitas cache). */
  readonly provider?: string;
  readonly model?: string;
}

/**
 * TREATMENT: Jev (jalur cache, SINKRON).
 *
 * Membaca evaluasi tersimpan untuk setiap evaluator, lalu menerapkan kebijakan
 * veto deterministik.
 *
 * KEBIJAKAN GAGAL: **FAIL CLOSED**. Evaluasi yang tidak ada, tidak valid, atau
 * tidak tersedia membuat status perlakuan `unavailable`/`invalid` → kandidat
 * TIDAK ditradingkan. Tidak ada fallback diam-diam ke baseline di dalam run
 * berlabel "jev treatment", karena itu mengontaminasi eksperimen.
 */
export class JevTreatment implements CandidateTreatment {
  readonly kind = "jev";
  readonly version = TREATMENT_VERSION;
  readonly configHash: string;
  readonly evaluatorVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly #store: JevEvaluationStore;
  readonly #config: JevVetoConfig;

  constructor(options: JevTreatmentOptions) {
    this.#store = options.store;
    this.#config = options.config ?? DEFAULT_JEV_VETO_CONFIG;
    this.evaluatorVersion = options.evaluatorVersion ?? JEV_EVALUATOR_VERSION;
    this.promptVersion = options.promptVersion ?? JEV_PROMPT_VERSION;
    this.schemaVersion = options.schemaVersion ?? JEV_SCHEMA_VERSION;
    this.provider = options.provider ?? "unknown";
    this.model = options.model ?? "unknown";
    this.configHash = jevVetoConfigHash(this.#config);
  }

  get config(): JevVetoConfig {
    return this.#config;
  }

  /** Evaluator yang diwajibkan kebijakan ini. */
  requiredEvaluators(): EvaluatorName[] {
    const wanted: EvaluatorName[] = ["trend_alignment", "momentum_sustainability", "reversal_risk"];
    if (this.#config.requireBtcEvaluator) {
      wanted.push("btc_regime");
    }
    return wanted;
  }

  evaluate(input: TreatmentInput): TreatmentResult {
    const results: Partial<Record<EvaluatorName, EvaluatorEvaluation>> = {};
    for (const evaluator of this.requiredEvaluators()) {
      const stored = this.#store.find({
        inputHash: input.inputHash,
        evaluator,
        evaluatorVersion: this.evaluatorVersion,
        promptVersion: this.promptVersion,
        schemaVersion: this.schemaVersion,
        provider: this.provider,
        model: this.model,
      });
      results[evaluator] = stored === null ? missingEvaluation(evaluator, this.evaluatorVersion, this.schemaVersion) : stored.evaluation;
    }

    const evaluations: TreatmentEvaluations = {
      trendAlignment: results.trend_alignment ?? null,
      momentumSustainability: results.momentum_sustainability ?? null,
      reversalRisk: results.reversal_risk ?? null,
      btcRegime: results.btc_regime ?? null,
    };

    const decision = applyJevVetoPolicy(evaluations, this.#config);
    return {
      kind: this.kind,
      treatmentVersion: this.version,
      treatmentConfigHash: this.configHash,
      status: decision.status,
      direction: input.direction,
      contract: input.input.contract,
      timeframe: input.input.timeframe,
      candleCloseTimeMs: input.input.candleCloseTimeMs,
      inputHash: input.inputHash,
      evaluations,
      reasons: decision.reasons,
    };
  }
}

export interface CollectJevOptions {
  readonly port: JevEvaluatorPort;
  readonly store: JevEvaluationStore;
  readonly evaluators: readonly EvaluatorName[];
  readonly timeoutMs?: number;
  readonly clock?: { nowMs(): number };
  readonly evaluatorVersion?: string;
  readonly promptVersion?: string;
  readonly schemaVersion?: string;
  /**
   * Dipanggil saat port melempar. Memungkinkan pemanggil (kolektor) menerapkan
   * kebijakan retry/fatal tanpa inti perlu tahu HTTP.
   */
  readonly onError?: (input: { evaluator: EvaluatorName; error: unknown }) => void;
}

/**
 * COLLECT: ambil evaluasi yang belum ada dari port eksternal, validasi, simpan.
 *
 * Ini SATU-SATUNYA tempat jaringan/LLM terjadi. Setelah evaluasi tersimpan,
 * replay dan evaluasi dapat diulang sepenuhnya offline dan deterministik (§29,
 * §30). Timeout per evaluator; kegagalan tidak melempar keluar.
 */
export async function collectJevEvaluations(
  input: { input: JevInput; inputHash: string },
  options: CollectJevOptions,
): Promise<JevUsageCounters> {
  const counters = blankUsage();
  const evaluatorVersion = options.evaluatorVersion ?? JEV_EVALUATOR_VERSION;
  const promptVersion = options.promptVersion ?? JEV_PROMPT_VERSION;
  const schemaVersion = options.schemaVersion ?? JEV_SCHEMA_VERSION;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const nowMs = options.clock?.nowMs() ?? 0;

  for (const evaluator of options.evaluators) {
    const identity = {
      inputHash: input.inputHash,
      evaluator,
      evaluatorVersion,
      promptVersion,
      schemaVersion,
      provider: options.port.provider,
      model: options.port.model,
    };
    if (options.store.find(identity) !== null) {
      counters.cacheHits += 1;
      continue;
    }
    counters.cacheMisses += 1;
    counters.requests += 1;

    let response;
    try {
      response = await withTimeout(
        options.port.evaluate({
          input: input.input,
          inputHash: input.inputHash,
          evaluator,
          evaluatorVersion,
          promptVersion,
          schemaVersion,
        }),
        timeoutMs,
      );
    } catch (error) {
      counters.unavailable += 1;
      options.onError?.({ evaluator, error });
      continue;
    }

    const validation = validateEvaluatorOutput(evaluator, schemaVersion, response.evaluation);
    if (!validation.ok || validation.evaluation === null) {
      counters.invalid += 1;
      continue;
    }
    counters.successes += 1;
    if (response.inputTokens !== null) counters.inputTokens += response.inputTokens;
    if (response.outputTokens !== null) counters.outputTokens += response.outputTokens;

    options.store.save({
      input: input.input,
      inputHash: input.inputHash,
      evaluator,
      identity: { evaluatorVersion, promptVersion, schemaVersion, provider: options.port.provider, model: options.port.model },
      evaluation: validation.evaluation,
      latencyMs: response.latencyMs,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      createdAtMs: nowMs,
    });
  }

  return counters;
}

function emptyEvaluations(): TreatmentEvaluations {
  return { trendAlignment: null, momentumSustainability: null, reversalRisk: null, btcRegime: null };
}

function missingEvaluation(
  evaluator: EvaluatorName,
  evaluatorVersion: string,
  schemaVersion: string,
): EvaluatorEvaluation {
  return {
    evaluator,
    evaluatorVersion,
    schemaVersion,
    probability: null,
    regime: null,
    confidence: null,
    reasonCodes: ["JEV_UNAVAILABLE"],
    modelMetadata: {},
    status: "unavailable",
  };
}

function blankUsage(): JevUsageCounters {
  return {
    requests: 0, cacheHits: 0, cacheMisses: 0, successes: 0,
    invalid: 0, unavailable: 0, errors: 0, inputTokens: 0, outputTokens: 0,
  };
}

/** Batas waktu tegas: tidak ada antrean tak terbatas, tidak ada freeze ingest. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("jev_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export type { StoredJevEvaluation };
