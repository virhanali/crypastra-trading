import type {
  Direction,
  LedgerEntryType,
  Liquidity,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionStatus,
  TimeInForce,
} from "@crypastra/core";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Skema persistensi — mengikuti docs/DATA-MODEL.md.
 *
 * PENTING (batas modul): file ini TIDAK boleh mengimpor `@crypastra/core` secara
 * runtime. drizzle-kit memuat file ini sebagai CJS, sedangkan `@crypastra/core`
 * ESM-only (`exports` tanpa kondisi `require`). Semua impor core di sini harus
 * `import type` (terhapus saat kompilasi). Konversi string <-> Decimal terjadi di
 * `decimal-codec.ts` pada batas repository. Lihat ADR 0005.
 *
 * Konvensi yang dikunci di Phase 1:
 *  - Waktu        : epoch MILISECOND (INTEGER), konsisten dengan `time_ms` Gate.io.
 *  - ID domain    : TEXT (UUID v4 lewat crypto.randomUUID), dibuat repository.
 *  - Urutan log   : INTEGER PRIMARY KEY AUTOINCREMENT (`seq`), monoton.
 *  - Uang/margin/PnL/fee/funding : TEXT skala 8 dp kanonik.
 *  - Harga/rate/spesifikasi kontrak : TEXT desimal polos (nilai eksak).
 *  - Kuantitas kontrak (`size`), interval funding (detik), timestamp : INTEGER.
 *  - Boolean      : INTEGER mode boolean.
 *
 * Tidak ada satu pun kolom REAL/NUMERIC. Ditegakkan tests/phase1-schema.test.ts.
 */

export type AccountMode = "live" | "simulation" | "replay";

// ─────────────────────────────────────────────────────────────
// REFERENCE
// ─────────────────────────────────────────────────────────────

export const contracts = sqliteTable("contracts", {
  id: text("id").primaryKey(),
  base: text("base").notNull(),
  quote: text("quote").notNull(),
  /** Desimal eksak; heterogen antar kontrak (0.0001 BTC, 1 altcoin, dst.). */
  quantoMultiplier: text("quanto_multiplier").notNull(),
  orderSizeMin: integer("order_size_min").notNull(),
  orderSizeMax: integer("order_size_max").notNull(),
  /** `enable_decimal` Gate.io: 14/997 kontrak true, dengan order_size_min = 0. */
  enableDecimal: integer("enable_decimal", { mode: "boolean" }).notNull(),
  /** Bisa sampai 11 dp (mis. SATS_USDT = 0.00000000001). Jangan batasi ke 8 dp. */
  orderPriceRound: text("order_price_round").notNull(),
  markPriceRound: text("mark_price_round").notNull(),
  leverageMin: text("leverage_min").notNull(),
  leverageMax: text("leverage_max").notNull(),
  maintenanceRate: text("maintenance_rate").notNull(),
  /** Bisa negatif (rebate maker). */
  makerFeeRate: text("maker_fee_rate").notNull(),
  takerFeeRate: text("taker_fee_rate").notNull(),
  fundingIntervalSeconds: integer("funding_interval_seconds").notNull(),
  marketOrderSlipRatio: text("market_order_slip_ratio"),
  status: text("status").notNull(),
  source: text("source").notNull(),
  rawJson: text("raw_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ─────────────────────────────────────────────────────────────
// MARKET
// ─────────────────────────────────────────────────────────────

export const candles = sqliteTable(
  "candles",
  {
    contract: text("contract").notNull(),
    interval: text("interval").notNull(),
    /** Open time candle dalam DETIK (Gate.io memakai detik untuk candle). */
    t: integer("t").notNull(),
    o: text("o").notNull(),
    h: text("h").notNull(),
    l: text("l").notNull(),
    c: text("c").notNull(),
    v: integer("v").notNull(),
    sum: text("sum").notNull(),
    windowClosed: integer("window_closed", { mode: "boolean" }).notNull(),
    provider: text("provider").notNull(),
    ingestedAt: integer("ingested_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.contract, table.interval, table.t] }),
    index("candles_contract_interval_t_idx").on(table.contract, table.interval, table.t),
  ],
);

export const marketEvents = sqliteTable(
  "market_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    channel: text("channel").notNull(),
    contract: text("contract").notNull(),
    eventTs: integer("event_ts").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payloadJson: text("payload_json").notNull(),
    ingestedAt: integer("ingested_at").notNull(),
  },
  (table) => [
    uniqueIndex("market_events_dedupe_key_idx").on(table.dedupeKey),
    index("market_events_contract_seq_idx").on(table.contract, table.seq),
  ],
);

// ─────────────────────────────────────────────────────────────
// TRADING
// ─────────────────────────────────────────────────────────────

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    contract: text("contract")
      .notNull()
      .references(() => contracts.id),
    side: text("side").$type<OrderSide>().notNull(),
    type: text("type").$type<OrderType>().notNull(),
    timeInForce: text("time_in_force").$type<TimeInForce>().notNull(),
    size: integer("size").notNull(),
    price: text("price"),
    reduceOnly: integer("reduce_only", { mode: "boolean" }).notNull(),
    leverage: text("leverage").notNull(),
    status: text("status").$type<OrderStatus>().notNull(),
    rejectReason: text("reject_reason"),
    filledSize: integer("filled_size").notNull(),
    avgFillPrice: text("avg_fill_price"),
    reservedMargin: text("reserved_margin"),
    tpPrice: text("tp_price"),
    slPrice: text("sl_price"),
    /** Audit saja. TIDAK boleh dibaca logika matching/margin/likuidasi. */
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("orders_account_status_idx").on(table.accountId, table.status),
    index("orders_contract_idx").on(table.contract),
  ],
);

export const positions = sqliteTable(
  "positions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    contract: text("contract")
      .notNull()
      .references(() => contracts.id),
    direction: text("direction").$type<Direction>().notNull(),
    status: text("status").$type<PositionStatus>().notNull(),
    size: integer("size").notNull(),
    entryPrice: text("entry_price").notNull(),
    leverage: text("leverage").notNull(),
    initialMargin: text("initial_margin").notNull(),
    /** > 0 = dibayar oleh trader. */
    accumulatedFunding: text("accumulated_funding").notNull(),
    feesPaid: text("fees_paid").notNull(),
    realizedPnl: text("realized_pnl").notNull(),
    tpPrice: text("tp_price"),
    slPrice: text("sl_price"),
    liquidationPrice: text("liquidation_price"),
    openedAt: integer("opened_at").notNull(),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
  },
  (table) => [
    index("positions_account_status_idx").on(table.accountId, table.status),
    index("positions_contract_idx").on(table.contract),
  ],
);

export const fills = sqliteTable(
  "fills",
  {
    id: text("id").primaryKey(),
    /** Nullable: fill likuidasi tidak berasal dari order (lihat ADR 0005). */
    orderId: text("order_id").references(() => orders.id),
    positionId: text("position_id").references(() => positions.id),
    contract: text("contract").notNull(),
    side: text("side").$type<OrderSide>().notNull(),
    size: integer("size").notNull(),
    price: text("price").notNull(),
    liquidity: text("liquidity").$type<Liquidity>().notNull(),
    fee: text("fee").notNull(),
    feeRate: text("fee_rate").notNull(),
    feeAsset: text("fee_asset").notNull(),
    realizedPnl: text("realized_pnl").notNull(),
    isLiquidation: integer("is_liquidation", { mode: "boolean" }).notNull(),
    isTpSl: integer("is_tp_sl", { mode: "boolean" }).notNull(),
    ts: integer("ts").notNull(),
  },
  (table) => [
    index("fills_order_idx").on(table.orderId),
    index("fills_position_idx").on(table.positionId),
  ],
);

export const orderEvents = sqliteTable(
  "order_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    type: text("type").notNull(),
    detailJson: text("detail_json").notNull(),
    ts: integer("ts").notNull(),
  },
  (table) => [index("order_events_order_seq_idx").on(table.orderId, table.seq)],
);

export const positionEvents = sqliteTable(
  "position_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id),
    type: text("type").notNull(),
    detailJson: text("detail_json").notNull(),
    ts: integer("ts").notNull(),
  },
  (table) => [index("position_events_position_seq_idx").on(table.positionId, table.seq)],
);

// ─────────────────────────────────────────────────────────────
// ACCOUNTING
// ─────────────────────────────────────────────────────────────

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mode: text("mode").$type<AccountMode>().notNull(),
  baseCurrency: text("base_currency").notNull(),
  initialBalance: text("initial_balance").notNull(),
  createdAt: integer("created_at").notNull(),
  resetAt: integer("reset_at"),
});

/** CACHE turunan ledger. Bukan sumber kebenaran akuntansi. */
export const accountBalances = sqliteTable("account_balances", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id),
  walletBalance: text("wallet_balance").notNull(),
  usedMargin: text("used_margin").notNull(),
  reservedMargin: text("reserved_margin").notNull(),
  realizedPnl: text("realized_pnl").notNull(),
  /** Kumulatif BIAYA fee (positif = trader membayar). Rebate menurunkannya. */
  feesPaid: text("fees_paid").notNull(),
  /** Kumulatif BIAYA funding (positif = trader membayar). */
  fundingPaid: text("funding_paid").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * LEDGER — append-only, sumber kebenaran saldo.
 *
 * Refinement Phase 1 terhadap docs/DATA-MODEL.md: pergerakan margin dipindah
 * dari `meta_json.marginDelta` ke kolom eksplisit `margin_delta`/`reserved_delta`.
 * Alasannya: rebuild saldo tidak boleh bergantung pada parsing JSON, dan
 * invariant "wallet_balance = Σ amount" tetap terjaga karena margin_* tidak
 * mengubah wallet.
 */
export const ledger = sqliteTable(
  "ledger",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    ts: integer("ts").notNull(),
    type: text("type").$type<LedgerEntryType>().notNull(),
    /** Delta wallet_balance bertanda. Positif menambah saldo. */
    amount: text("amount").notNull(),
    /** Delta used_margin bertanda. Hanya diisi tipe margin_*. */
    marginDelta: text("margin_delta").notNull(),
    /** Delta reserved_margin bertanda. */
    reservedDelta: text("reserved_delta").notNull(),
    balanceAfter: text("balance_after").notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    metaJson: text("meta_json").notNull(),
  },
  (table) => [
    uniqueIndex("ledger_idempotency_key_idx").on(table.idempotencyKey),
    index("ledger_account_seq_idx").on(table.accountId, table.seq),
  ],
);

// ─────────────────────────────────────────────────────────────
// STRATEGY / JEV (skema siap, perilaku belum diimplementasikan)
// ─────────────────────────────────────────────────────────────

export const featureSnapshots = sqliteTable(
  "feature_snapshots",
  {
    id: text("id").primaryKey(),
    contract: text("contract").notNull(),
    interval: text("interval").notNull(),
    t: integer("t").notNull(),
    featuresJson: text("features_json").notNull(),
    engineVersion: text("engine_version").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("feature_snapshots_contract_t_idx").on(table.contract, table.t),
    uniqueIndex("feature_snapshots_unique_idx").on(
      table.contract,
      table.interval,
      table.t,
      table.engineVersion,
    ),
  ],
);

/**
 * Hasil Hard Scanner (Phase 9). Tabel riset/analitik terpisah, BUKAN
 * `domain_events` (peristiwa ekonomi) dan BUKAN `decisions` (keputusan ekonomi
 * dengan ukuran posisi/leverage yang belum ada). Idempoten per
 * (contract, interval, t, feature_version, scanner_version, config_hash).
 */
export const scannerResults = sqliteTable(
  "scanner_results",
  {
    id: text("id").primaryKey(),
    contract: text("contract").notNull(),
    interval: text("interval").notNull(),
    t: integer("t").notNull(),
    featureVersion: text("feature_version").notNull(),
    scannerVersion: text("scanner_version").notNull(),
    scannerConfigHash: text("scanner_config_hash").notNull(),
    status: text("status").notNull(),
    direction: text("direction").notNull(),
    setupType: text("setup_type").notNull(),
    signal: text("signal").notNull(),
    factsJson: text("facts_json").notNull(),
    reasonCodesJson: text("reason_codes_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("scanner_results_unique_idx").on(
      table.contract,
      table.interval,
      table.t,
      table.featureVersion,
      table.scannerVersion,
      table.scannerConfigHash,
    ),
    index("scanner_results_contract_t_idx").on(table.contract, table.t),
    index("scanner_results_signal_idx").on(table.signal, table.t),
  ],
);

/**
 * Evaluasi Jev (Phase 12) — baris per evaluator, sekaligus CACHE.
 *
 * Idempoten lewat `jev_evaluations_cache_idx`: identitas cache = (input hash,
 * evaluator, versi evaluator/prompt/skema, provider, model). Mengubah prompt
 * atau produksi model menghasilkan identitas baru, bukan menimpa hasil lama.
 *
 * Tidak menyimpan rahasia: `metadata_json` hanya memuat metadata aman.
 */
export const jevEvaluations = sqliteTable(
  "jev_evaluations",
  {
    id: text("id").primaryKey(),
    inputHash: text("input_hash").notNull(),
    contract: text("contract").notNull(),
    interval: text("interval").notNull(),
    t: integer("t").notNull(),
    direction: text("direction").notNull(),
    evaluator: text("evaluator").notNull(),
    evaluatorVersion: text("evaluator_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    probability: text("probability"),
    regimeJson: text("regime_json"),
    confidence: text("confidence"),
    status: text("status").notNull(),
    reasonCodesJson: text("reason_codes_json").notNull(),
    outputJson: text("output_json").notNull(),
    metadataJson: text("metadata_json").notNull(),
    inputsJson: text("inputs_json").notNull(),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("jev_evaluations_cache_idx").on(
      table.inputHash,
      table.evaluator,
      table.evaluatorVersion,
      table.promptVersion,
      table.schemaVersion,
      table.provider,
      table.model,
    ),
    index("jev_evaluations_contract_t_idx").on(table.contract, table.t),
    index("jev_evaluations_status_idx").on(table.status),
  ],
);

/**
 * Hasil perlakuan (Phase 12) — keputusan ALLOW/VETO deterministik per kandidat.
 * Audit trail untuk analisis A/B; bukan tabel ekonomi.
 */
export const treatmentResults = sqliteTable(
  "treatment_results",
  {
    id: text("id").primaryKey(),
    inputHash: text("input_hash").notNull(),
    contract: text("contract").notNull(),
    interval: text("interval").notNull(),
    t: integer("t").notNull(),
    direction: text("direction").notNull(),
    treatmentKind: text("treatment_kind").notNull(),
    treatmentVersion: text("treatment_version").notNull(),
    treatmentConfigHash: text("treatment_config_hash").notNull(),
    status: text("status").notNull(),
    reasonsJson: text("reasons_json").notNull(),
    evaluationsJson: text("evaluations_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("treatment_results_unique_idx").on(
      table.inputHash,
      table.treatmentVersion,
      table.treatmentConfigHash,
    ),
    index("treatment_results_status_idx").on(table.status, table.t),
    index("treatment_results_contract_t_idx").on(table.contract, table.t),
  ],
);

/**
 * Label hasil (Phase 13) — OFFLINE. Tabel ini memuat informasi MASA DEPAN dan
 * karenanya TERPISAH TOTAL dari `jev_evaluations`: baris Jev tidak pernah
 * dimutasi dengan label, dan jalur keputusan/eksekusi hidup tidak dapat
 * membacanya (guard impor).
 */
export const candidateOutcomeLabels = sqliteTable(
  "candidate_outcome_labels",
  {
    id: text("id").primaryKey(),
    inputHash: text("input_hash").notNull(),
    contract: text("contract").notNull(),
    interval: text("interval").notNull(),
    t: integer("t").notNull(),
    direction: text("direction").notNull(),
    labelVersion: text("label_version").notNull(),
    priceSource: text("price_source").notNull(),
    referenceClose: text("reference_close").notNull(),
    atr14: text("atr14"),
    horizonsJson: text("horizons_json").notNull(),
    labelsJson: text("labels_json").notNull(),
    status: text("status").notNull(),
    incompleteReason: text("incomplete_reason"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("candidate_outcome_labels_unique_idx").on(table.inputHash, table.labelVersion),
    index("candidate_outcome_labels_contract_t_idx").on(table.contract, table.t),
    index("candidate_outcome_labels_status_idx").on(table.status),
  ],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    contract: text("contract").notNull(),
    interval: text("interval").notNull(),
    candleCloseT: integer("candle_close_t").notNull(),
    action: text("action").notNull(),
    direction: text("direction").$type<Direction>(),
    sizeText: text("size_text"),
    leverage: text("leverage"),
    referencePrice: text("reference_price"),
    tpPrice: text("tp_price"),
    slPrice: text("sl_price"),
    notional: text("notional"),
    initialMargin: text("initial_margin"),
    riskAmount: text("risk_amount"),
    riskPercent: text("risk_percent"),
    rewardAmount: text("reward_amount"),
    rewardRiskRatio: text("reward_risk_ratio"),
    stopDistance: text("stop_distance"),
    stopDistancePct: text("stop_distance_pct"),
    reasonsJson: text("reasons_json").notNull(),
    riskJson: text("risk_json").notNull(),
    jevEvaluationId: text("jev_evaluation_id").references(() => jevEvaluations.id),
    decisionVersion: text("decision_version").notNull(),
    featureVersion: text("feature_version").notNull(),
    scannerVersion: text("scanner_version").notNull(),
    scannerConfigHash: text("scanner_config_hash").notNull(),
    riskPolicyVersion: text("risk_policy_version").notNull(),
    riskPolicyHash: text("risk_policy_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("decisions_unique_idx").on(
      table.accountId,
      table.contract,
      table.interval,
      table.candleCloseT,
      table.decisionVersion,
      table.scannerVersion,
      table.scannerConfigHash,
      table.riskPolicyHash,
    ),
    index("decisions_contract_created_idx").on(table.contract, table.createdAt),
    index("decisions_account_candle_idx").on(table.accountId, table.candleCloseT),
    index("decisions_action_idx").on(table.action, table.direction),
  ],
);

/**
 * Linkage eksekusi otonom (Phase 11). Menjawab: keputusan X → dicoba?
 * → command id? → order id? → status? → alasan gagal?
 *
 * Unik per `decision_id`: satu keputusan disetujui = paling banyak satu entry.
 * Ini BUKAN tabel ekonomi; sumber kebenaran ekonomi tetap orders/fills/positions/
 * ledger. Tidak menyimpan ulang data order.
 */
export const decisionExecutions = sqliteTable(
  "decision_executions",
  {
    id: text("id").primaryKey(),
    decisionId: text("decision_id").notNull(),
    accountId: text("account_id").notNull(),
    commandId: text("command_id").notNull(),
    orderId: text("order_id"),
    positionId: text("position_id"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    plannedReference: text("planned_reference"),
    actualFillPrice: text("actual_fill_price"),
    attemptedAt: integer("attempted_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("decision_executions_decision_idx").on(table.decisionId),
    index("decision_executions_status_idx").on(table.status),
  ],
);

/**
 * TradeRecord (Phase 11) — DERIVED, bukan authoritative. Materialisasi riset
 * yang dibangun dari sumber ekonomi kanonik (orders/fills/positions/ledger)
 * untuk evaluasi baseline. Boleh dibangun ulang.
 */
export const tradeRecords = sqliteTable(
  "trade_records",
  {
    tradeId: text("trade_id").primaryKey(),
    accountId: text("account_id").notNull(),
    decisionId: text("decision_id").notNull(),
    contract: text("contract").notNull(),
    side: text("side").notNull(),
    decisionTime: integer("decision_time").notNull(),
    entryTime: integer("entry_time").notNull(),
    exitTime: integer("exit_time"),
    plannedReference: text("planned_reference").notNull(),
    actualEntry: text("actual_entry").notNull(),
    size: integer("size").notNull(),
    leverage: text("leverage").notNull(),
    stopLoss: text("stop_loss").notNull(),
    takeProfit: text("take_profit").notNull(),
    plannedRisk: text("planned_risk").notNull(),
    actualInitialRisk: text("actual_initial_risk").notNull(),
    grossRealizedPnl: text("gross_realized_pnl").notNull(),
    fees: text("fees").notNull(),
    funding: text("funding").notNull(),
    netPnl: text("net_pnl").notNull(),
    exitReason: text("exit_reason").notNull(),
    mae: text("mae").notNull(),
    mfe: text("mfe").notNull(),
    maeR: text("mae_r"),
    mfeR: text("mfe_r"),
    rMultiple: text("r_multiple"),
    holdingDuration: integer("holding_duration"),
    featureVersion: text("feature_version").notNull(),
    scannerVersion: text("scanner_version").notNull(),
    scannerConfigHash: text("scanner_config_hash").notNull(),
    decisionVersion: text("decision_version").notNull(),
    riskPolicyVersion: text("risk_policy_version").notNull(),
    riskPolicyHash: text("risk_policy_hash").notNull(),
    evaluationVersion: text("evaluation_version").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("trade_records_decision_idx").on(table.decisionId),
    index("trade_records_account_exit_idx").on(table.accountId, table.exitTime),
    index("trade_records_contract_exit_idx").on(table.contract, table.exitTime),
  ],
);

export const accountConfig = sqliteTable("account_config", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id),
  defaultLeverage: text("default_leverage").notNull(),
  maxLeverage: text("max_leverage").notNull(),
  maxPositionNotional: text("max_position_notional").notNull(),
  riskPerTradePct: text("risk_per_trade_pct").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Idempotensi tingkat PERINTAH (Phase 3).
 *
 * Ledger punya idempotency_key per entri, tapi satu perintah order menghasilkan
 * BANYAK efek (reservasi, N fill, fee, PnL, posisi). Baris di sini adalah kunci
 * "perintah ini sudah dijalankan", sehingga retry tidak menggandakan efek
 * ekonomi apa pun. Lihat ADR 0007.
 */
export const tradeCommands = sqliteTable(
  "trade_commands",
  {
    commandId: text("command_id").primaryKey(),
    /** submit_order | evaluate_order | cancel_order */
    kind: text("kind").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /** Order yang dihasilkan perintah (null bila perintah gagal sebelum order dibuat). */
    orderId: text("order_id").references(() => orders.id),
    /**
     * Sidik jari payload perintah. Dipakai untuk mendeteksi commandId yang sama
     * dengan payload BERBEDA (konflik idempotensi), bukan sekadar retry.
     */
    requestHash: text("request_hash"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("trade_commands_order_idx").on(table.orderId)],
);

/**
 * Outbox event domain (Phase 5).
 *
 * Sumber kebenaran tunggal untuk realtime. Perubahan keadaan finansial dan
 * event publiknya ditulis dalam SATU transaksi (transactional outbox), sehingga
 * `afterSeq=N` punya arti yang tepat dan crash tidak menghilangkan event.
 *
 * `seq` adalah urutan global monoton lintas agregat. Tabel `order_events`,
 * `position_events`, dan `ledger` tetap punya urutannya sendiri untuk audit
 * per-agregat; realtime memakai `seq` di sini.
 */
export const domainEvents = sqliteTable(
  "domain_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /** Mis. order.created | position.closed | funding.applied | ledger.created */
    type: text("type").notNull(),
    /** order | position | account | ledger | fill */
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id"),
    /** Perintah yang menghasilkan event ini, untuk audit/idempotensi. */
    commandId: text("command_id"),
    dataJson: text("data_json").notNull(),
    ts: integer("ts").notNull(),
  },
  (table) => [index("domain_events_account_seq_idx").on(table.accountId, table.seq)],
);

/**
 * Sesi perekaman pasar (Phase 8).
 *
 * Replay menunjuk SESI yang eksplisit, bukan menebak rentang waktu dari tabel
 * yang tidak berhubungan.
 */
export const marketRecordingSessions = sqliteTable(
  "market_recording_sessions",
  {
    id: text("id").primaryKey(),
    /** live | simulation */
    source: text("source").notNull(),
    /** Daftar kontrak yang direkam, JSON array. */
    contractsJson: text("contracts_json").notNull(),
    /** recording | completed | aborted */
    status: text("status").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    metadataJson: text("metadata_json").notNull(),
  },
  (table) => [index("recording_sessions_status_idx").on(table.status, table.startedAt)],
);

/**
 * Observasi pasar ternormalisasi, append-only (Phase 8).
 *
 * Catatan penting: tabel ini adalah REKAMAN DATA PASAR, bukan event domain.
 * `domain_events` tetap berisi peristiwa ekonomi/aplikasi; keduanya tidak
 * pernah dicampur (ADR 0011).
 *
 * Nilai finansial disimpan sebagai STRING kanonik di `data_json`.
 * `seq` adalah urutan total kanonik untuk replay (`ORDER BY seq ASC`).
 */
export const marketObservations = sqliteTable(
  "market_observations",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => marketRecordingSessions.id),
    contract: text("contract").notNull(),
    /** mark | quote | funding | candle */
    kind: text("kind").notNull(),
    /** Jam sumber (exchange), epoch ms — metadata kronologi pasar. */
    sourceTimestampMs: integer("source_timestamp_ms").notNull(),
    /** Jam lokal saat diterima, epoch ms — menggerakkan VirtualClock. */
    observedAtMs: integer("observed_at_ms").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    dataJson: text("data_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("market_observations_dedupe_idx").on(table.dedupeKey),
    index("market_observations_session_seq_idx").on(table.sessionId, table.seq),
    index("market_observations_session_kind_idx").on(table.sessionId, table.kind, table.seq),
    index("market_observations_session_contract_idx").on(table.sessionId, table.contract, table.seq),
    // Freshness check O(log n): "observasi terakhir sesi X" tanpa full scan.
    // Hot loop recorder + healthcheck memakainya tiap detik/menit; tanpa
    // indeks ini max(observed_at_ms) memindai seluruh sesi (jutaan baris).
    index("market_observations_session_observed_idx").on(table.sessionId, table.observedAtMs),
  ],
);

export const schemaTables = {
  contracts,
  candles,
  marketEvents,
  orders,
  positions,
  fills,
  orderEvents,
  positionEvents,
  accounts,
  accountBalances,
  ledger,
  featureSnapshots,
  jevEvaluations,
  decisions,
  accountConfig,
  tradeCommands,
  domainEvents,
  marketRecordingSessions,
  marketObservations,
} as const;
