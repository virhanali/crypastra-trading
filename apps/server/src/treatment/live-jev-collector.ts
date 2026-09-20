import {
  collectJevEvaluations,
  type EvaluatorName,
  type JevEvaluationStore,
  type JevEvaluatorPort,
  type JevInput,
} from "@crypastra/core";

/**
 * LiveJevCollector (Phase 13) — pengumpulan evaluasi Jev ASINKRON dan TERBATAS.
 *
 * JAMINAN UTAMA: `MarketRuntime`, pemrosesan risiko, TP/SL, dan likuidasi TIDAK
 * PERNAH menunggu Jev. `enqueue` sinkron dan tidak memblokir; bila antrean penuh
 * permintaan DIBUANG dengan pencatatan eksplisit, bukan memblokir ingest.
 *
 * Perlakuan hanya boleh mengonsumsi evaluasi yang SUDAH lengkap dan tersimpan.
 */

export type CandidateStatus = "complete" | "partial" | "missing" | "invalid" | "unavailable";

export interface CollectionStatus {
  queued: number;
  inFlight: number;
  completed: number;
  cacheHits: number;
  cacheMisses: number;
  success: number;
  invalid: number;
  unavailable: number;
  timeout: number;
  rateLimited: number;
  retryCount: number;
  queueDropped: number;
  fatalErrors: number;
}

export interface LiveJevCollectorOptions {
  readonly port: JevEvaluatorPort;
  readonly store: JevEvaluationStore;
  readonly evaluators: readonly EvaluatorName[];
  /** Kapasitas antrean; penuh = dibuang (tidak memblokir). Default 200. */
  readonly queueCapacity?: number;
  /** Worker paralel. Default 2. */
  readonly concurrency?: number;
  /** Batas laju permintaan per menit. Default 60. */
  readonly requestsPerMinute?: number;
  readonly timeoutMs?: number;
  /** Percobaan ulang MAKSIMUM untuk error yang boleh diulang. Default 2. */
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly clock?: { nowMs(): number };
  readonly onDiagnostic?: (event: { type: string; detail: string }) => void;
}

interface QueueEntry {
  readonly input: JevInput;
  readonly inputHash: string;
  attempts: number;
}

export class LiveJevCollector {
  readonly #port: JevEvaluatorPort;
  readonly #store: JevEvaluationStore;
  readonly #evaluators: readonly EvaluatorName[];
  readonly #capacity: number;
  readonly #concurrency: number;
  readonly #requestsPerMinute: number;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #clock: { nowMs(): number };
  readonly #onDiagnostic: LiveJevCollectorOptions["onDiagnostic"];
  readonly #queue: QueueEntry[] = [];
  /** Jejak waktu permintaan untuk pembatas laju. */
  readonly #requestTimes: number[] = [];
  /** Status per kandidat: evaluator yang berhasil / gagal. */
  readonly #candidateState = new Map<string, { success: Set<string>; invalid: Set<string>; unavailable: Set<string> }>();
  #inFlight = 0;
  #stopped = false;
  #pump: Promise<void> | null = null;
  #status: CollectionStatus = blankStatus();

  constructor(options: LiveJevCollectorOptions) {
    this.#port = options.port;
    this.#store = options.store;
    this.#evaluators = options.evaluators;
    this.#capacity = options.queueCapacity ?? 200;
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#requestsPerMinute = Math.max(1, options.requestsPerMinute ?? 60);
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#retryDelayMs = options.retryDelayMs ?? 250;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#onDiagnostic = options.onDiagnostic;
  }

  /**
   * Antrekan satu kandidat. SINKRON dan tidak pernah memblokir.
   * Mengembalikan false bila antrean penuh (permintaan dibuang).
   */
  enqueue(entry: { input: JevInput; inputHash: string }): boolean {
    if (this.#stopped) {
      return false;
    }
    // Semua evaluator sudah tercache → tidak perlu antre.
    const missing = this.#evaluators.filter((evaluator) => this.#cached(entry.inputHash, evaluator) === null);
    if (missing.length === 0) {
      this.#status.cacheHits += this.#evaluators.length;
      this.#recordCandidate(entry.inputHash, this.#evaluators, "success");
      return true;
    }
    this.#status.cacheMisses += missing.length;

    // Kapasitas mencakup pekerjaan yang sedang berjalan: tanpa ini, antrean
    // "penuh" bisa tetap menerima permintaan selama worker masih sibuk.
    if (this.#queue.length + this.#inFlight >= this.#capacity) {
      this.#status.queueDropped += 1;
      this.#onDiagnostic?.({ type: "QUEUE_FULL", detail: `${entry.inputHash} dibuang` });
      return false;
    }
    this.#queue.push({ input: entry.input, inputHash: entry.inputHash, attempts: 0 });
    this.#status.queued = this.#queue.length;
    this.#startPump();
    return true;
  }

  status(): CollectionStatus {
    return { ...this.#status, queued: this.#queue.length, inFlight: this.#inFlight };
  }

  /** Status kelengkapan per kandidat. 3/4 evaluator BUKAN "complete". */
  candidateStatus(inputHash: string): CandidateStatus {
    const state = this.#candidateState.get(inputHash);
    if (state === undefined) {
      return "missing";
    }
    const required = this.#evaluators.length;
    if (state.success.size >= required) return "complete";
    if (state.invalid.size > 0) return "invalid";
    if (state.unavailable.size > 0) return "unavailable";
    if (state.success.size > 0) return "partial";
    return "missing";
  }

  /** Tunggu sampai antrean kosong (untuk test/backfill). Tidak dipakai live. */
  async drain(): Promise<void> {
    while (this.#queue.length > 0 || this.#inFlight > 0) {
      this.#startPump();
      await (this.#pump ?? Promise.resolve());
      if (this.#queue.length === 0 && this.#inFlight === 0) break;
    }
  }

  stop(): void {
    this.#stopped = true;
  }

  #startPump(): void {
    if (this.#pump !== null) {
      return;
    }
    this.#pump = this.#runPump().finally(() => {
      this.#pump = null;
    });
  }

  async #runPump(): Promise<void> {
    const workers = Array.from({ length: this.#concurrency }, () => this.#worker());
    await Promise.all(workers);
  }

  async #worker(): Promise<void> {
    for (;;) {
      const entry = this.#queue.shift();
      if (entry === undefined) {
        return;
      }
      this.#status.queued = this.#queue.length;
      this.#inFlight += 1;
      try {
        await this.#process(entry);
      } finally {
        this.#inFlight -= 1;
      }
    }
  }

  async #process(entry: QueueEntry): Promise<void> {
    await this.#respectRateLimit();
    let errorKind: "retryable" | "invalid" | "fatal" | null = null;
    try {
      const counters = await collectJevEvaluations(
        { input: entry.input, inputHash: entry.inputHash },
        {
          port: this.#port,
          store: this.#store,
          evaluators: this.#evaluators,
          timeoutMs: this.#timeoutMs,
          clock: this.#clock,
          onError: ({ error }) => {
            errorKind = errorKind ?? classifyJevError(error);
          },
        },
      );
      this.#status.completed += 1;
      this.#status.cacheHits += counters.cacheHits;
      this.#status.cacheMisses += counters.cacheMisses;
      this.#status.success += counters.successes;
      this.#status.invalid += counters.invalid;
      this.#status.unavailable += counters.unavailable;
      this.#recordCandidate(
        entry.inputHash,
        this.#evaluators.filter((evaluator) => counters.successes > 0),
        counters.successes > 0 ? "success" : "unavailable",
      );
      if (counters.successes < this.#evaluators.length) {
        this.#onDiagnostic?.({
          type: "COLLECTION_INCOMPLETE",
          detail: `${entry.inputHash} success=${counters.successes}/${this.#evaluators.length}`,
        });
      }
      // Kegagalan yang boleh diulang: ulangi KANDIDAT yang sama. Evaluator yang
      // sudah berhasil tersimpan di cache, jadi pengulangan hanya mengambil
      // yang gagal — tidak pernah menggandakan evaluasi.
      if (errorKind === "retryable" && entry.attempts < this.#maxRetries) {
        entry.attempts += 1;
        this.#status.retryCount += 1;
        this.#onDiagnostic?.({ type: "COLLECTION_RETRY", detail: `${entry.inputHash} attempt=${entry.attempts}` });
        await this.#sleep(this.#retryDelayMs * entry.attempts);
        this.#queue.push(entry);
        return;
      }
      if (errorKind === "invalid") {
        this.#status.invalid += 1;
        this.#recordCandidate(entry.inputHash, [], "invalid");
        return;
      }
      if (errorKind === "fatal") {
        this.#status.fatalErrors += 1;
        this.#onDiagnostic?.({ type: "COLLECTOR_FATAL", detail: `${entry.inputHash} auth/config` });
        this.#recordCandidate(entry.inputHash, [], "unavailable");
        return;
      }
      if (errorKind === "retryable") {
        this.#status.unavailable += 1;
        this.#recordCandidate(entry.inputHash, [], "unavailable");
      }
    } catch (error) {
      // Pengambilan ulang TIDAK boleh menggandakan evaluasi: identitas cache
      // Phase 12 tetap otoritatif, jadi pengulangan aman.
      const kind = classifyJevError(error);
      if (kind === "retryable" && entry.attempts < this.#maxRetries) {
        entry.attempts += 1;
        this.#status.retryCount += 1;
        this.#onDiagnostic?.({ type: "COLLECTION_RETRY", detail: `${entry.inputHash} attempt=${entry.attempts}` });
        await this.#sleep(this.#retryDelayMs * entry.attempts);
        this.#queue.push(entry);
        return;
      }
      if (kind === "invalid") {
        this.#status.invalid += 1;
        this.#recordCandidate(entry.inputHash, [], "invalid");
        return;
      }
      if (kind === "fatal") {
        this.#status.fatalErrors += 1;
        this.#onDiagnostic?.({ type: "COLLECTOR_FATAL", detail: String(error) });
        this.#recordCandidate(entry.inputHash, [], "unavailable");
        return;
      }
      this.#status.unavailable += 1;
      this.#recordCandidate(entry.inputHash, [], "unavailable");
    }
  }

  /** Pembatas laju: menunggu di WORKER, tidak pernah di jalur ingest. */
  async #respectRateLimit(): Promise<void> {
    for (;;) {
      const now = this.#clock.nowMs();
      const windowStart = now - 60_000;
      while (this.#requestTimes.length > 0 && this.#requestTimes[0]! < windowStart) {
        this.#requestTimes.shift();
      }
      if (this.#requestTimes.length < this.#requestsPerMinute) {
        this.#requestTimes.push(now);
        return;
      }
      this.#status.rateLimited += 1;
      this.#onDiagnostic?.({ type: "RATE_LIMITED", detail: `menunggu jendela 60s` });
      await this.#sleep(50);
    }
  }

  #cached(inputHash: string, evaluator: EvaluatorName) {
    return this.#store.find({
      inputHash,
      evaluator,
      evaluatorVersion: this.#evaluatorVersion(),
      promptVersion: this.#promptVersion(),
      schemaVersion: this.#schemaVersion(),
      provider: this.#port.provider,
      model: this.#port.model,
    });
  }

  #evaluatorVersion(): string {
    return this.#versions.evaluator;
  }
  #promptVersion(): string {
    return this.#versions.prompt;
  }
  #schemaVersion(): string {
    return this.#versions.schema;
  }
  readonly #versions = { evaluator: "jev-eval-v1", prompt: "jev-prompt-v1", schema: "jev-schema-v1" };

  #recordCandidate(inputHash: string, evaluators: readonly EvaluatorName[], outcome: "success" | "invalid" | "unavailable"): void {
    let state = this.#candidateState.get(inputHash);
    if (state === undefined) {
      state = { success: new Set(), invalid: new Set(), unavailable: new Set() };
      this.#candidateState.set(inputHash, state);
    }
    for (const evaluator of evaluators) {
      state.success.add(evaluator);
    }
    if (outcome === "invalid") {
      for (const evaluator of this.#evaluators) state.invalid.add(evaluator);
    }
    if (outcome === "unavailable" && state.success.size === 0) {
      for (const evaluator of this.#evaluators) state.unavailable.add(evaluator);
    }
  }

  async #sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

function blankStatus(): CollectionStatus {
  return {
    queued: 0, inFlight: 0, completed: 0, cacheHits: 0, cacheMisses: 0,
    success: 0, invalid: 0, unavailable: 0, timeout: 0, rateLimited: 0,
    retryCount: 0, queueDropped: 0, fatalErrors: 0,
  };
}

/**
 * Klasifikasi kegagalan (kebijakan eksplisit, §11):
 *  - retryable: timeout / 429 / 5xx / jaringan
 *  - invalid: output terstruktur cacat → jangan menghantam provider berulang
 *  - fatal: auth/config (401/403) → health kolektor rusak
 */
export function classifyJevError(error: unknown): "retryable" | "invalid" | "fatal" {
  const message = error instanceof Error ? error.message : String(error);
  if (/jev_http_40[13]/.test(message)) return "fatal";
  if (/jev_malformed_response|jev_invalid_output/.test(message)) return "invalid";
  if (/jev_http_429|jev_http_5\d\d|jev_timeout|fetch failed|network|ECONN|aborted/.test(message)) return "retryable";
  return "retryable";
}
