# crypastra — Data Model

SQLite + Drizzle ORM (`bun:sqlite`), mengikuti konvensi piastra
(`apps/server/src/db/schema.ts` + `apps/server/drizzle/` + `drizzle.config.ts`).

Status: **diimplementasikan di Phase 1.** Skema ada di `apps/server/src/db/schema.ts`,
migrasi di `apps/server/drizzle/`, dan keputusan persistensi di
`docs/decisions/0005-persistence-foundation.md`.

## Konvensi waktu & identifier (dikunci Phase 1)

| Hal | Konvensi |
|---|---|
| Waktu | epoch **milidetik**, INTEGER. Konsisten dengan `time_ms` Gate.io |
| Waktu candle | `candles.t` = epoch **detik** (open time), mengikuti Gate.io |
| ID domain | TEXT, UUID v4 (`crypto.randomUUID`), dibuat repository |
| Urutan log | INTEGER PRIMARY KEY AUTOINCREMENT (`seq`) pada tabel log |
| Boolean | INTEGER mode boolean (0/1) |

`seq` adalah urutan total deterministik untuk replay. Timestamp tidak dipakai untuk
mengurutkan karena bisa sama atau tidak monoton.

## Aturan penyimpanan angka

| Jenis | Tipe kolom | Format | Alasan |
|---|---|---|---|
| Uang / margin / PnL / fee / funding | `text` | decimal string **8 dp kanonik** | tidak boleh float; SQLite REAL = float64 |
| Harga / tick / rate / spec kontrak | `text` | desimal polos, **nilai eksak** (bisa >8 dp) | `order_price_round` Gate.io sampai 11 dp (SATS_USDT) |
| Kuantitas kontrak (`size`) | `integer` | kontrak, satuan bulat | Gate.io `enable_decimal:false` → size bulat |
| Waktu | `integer` | epoch ms (candle: detik) | — |
| Flag | `integer` | boolean mode | — |
| JSON payload | `text` | JSON string | mengikuti pola `payload_json` piastra |

Konversi string <-> Decimal terjadi **hanya** di `apps/server/src/db/decimal-codec.ts`:
`encodeMoney`/`decodeMoney` (8 dp kanonik) dan `encodeDecimalString` (eksak).
`Number`, `parseFloat`, dan `.toNumber()` dilarang di `apps/server`
(ditegakkan `tests/phase1-boundaries.test.ts`).

**Catatan SQLite:** jangan pakai `REAL` untuk uang meski terlihat praktis. Jangan
andalkan `NUMERIC` (SQLite memperlakukannya sebagai REAL bila bukan integer).
Agregasi uang dilakukan di `Decimal` setelah SELECT, atau lewat query yang
mengembalikan string.

## Entitas

Kelompok: **Reference** (kontrak & spesifikasi), **Market** (data pasar tersimpan),
**Trading** (order/posisi), **Accounting** (ledger), **Strategy/Jev** (belum aktif).

### Reference

```
contracts
  id TEXT PK                 -- "BTC_USDT"
  base TEXT                  -- "BTC"
  quote TEXT                 -- "USDT"
  quanto_multiplier TEXT
  order_size_min INTEGER
  order_size_max INTEGER
  order_price_round TEXT
  mark_price_round TEXT
  leverage_min TEXT
  leverage_max TEXT
  maintenance_rate TEXT       -- MMR
  maker_fee_rate TEXT
  taker_fee_rate TEXT
  funding_interval INTEGER    -- detik, mis. 28800
  status TEXT                 -- hanya "trading" boleh ditrade
  raw_json TEXT               -- payload asli, untuk audit perubahan spec
  updated_at INTEGER
```

### Market (persisten, untuk replay)

```
candles
  contract TEXT
  interval TEXT               -- "5m"
  t INTEGER                   -- open time, detik (Gate.io pakai dtk utk candle)
  o,h,l,c TEXT
  v INTEGER                   -- size kontrak
  sum TEXT                    -- notional quote
  window_closed INTEGER       -- 1 bila w:false final
  provider TEXT
  ingested_at INTEGER
  PRIMARY KEY (contract, interval, t)

market_events            -- raw append-only untuk replay & audit ingest
  seq INTEGER PK AUTOINCREMENT
  provider TEXT
  channel TEXT              -- "futures.tickers" | "futures.candlesticks" | ...
  contract TEXT
  event_ts INTEGER          -- ms
  dedupe_key TEXT           -- idempotensi
  payload_json TEXT
  UNIQUE(dedupe_key)
```

`market_events` adalah sumber replay yang jujur. `candles` adalah materialisasi
yang cepat dibaca. Keduanya bukan sumber kebenaran akuntansi.

### Trading

```
orders                   -- status mengikuti state machine (ACCOUNTING.md §8)
  id TEXT PK
  account_id TEXT FK
  contract TEXT FK
  side TEXT                 -- buy | sell
  type TEXT                 -- market | limit
  time_in_force TEXT        -- gtc | ioc | fok | post_only
  size INTEGER              -- kontrak
  price TEXT NULL           -- limit saja
  reduce_only INTEGER
  leverage TEXT
  status TEXT               -- created|validated|rejected|open|partially_filled|filled|cancelled|expired
  reject_reason TEXT NULL
  filled_size INTEGER
  avg_fill_price TEXT NULL
  reserved_margin TEXT NULL
  tp_price TEXT NULL
  sl_price TEXT NULL
  source TEXT               -- human|strategy|jev|replay|test  (audit saja, TIDAK mengubah perilaku)
  created_at INTEGER
  updated_at INTEGER

fills
  id TEXT PK
  order_id TEXT FK
  position_id TEXT NULL FK
  contract TEXT
  side TEXT
  size INTEGER
  price TEXT
  liquidity TEXT            -- maker | taker
  fee TEXT
  fee_rate TEXT
  fee_asset TEXT
  realized_pnl TEXT         -- utk fill yang mengurangi posisi
  is_liquidation INTEGER
  is_tp_sl INTEGER
  ts INTEGER

positions
  id TEXT PK
  account_id TEXT FK
  contract TEXT FK
  direction TEXT            -- long | short
  status TEXT               -- open | closed | liquidated
  size INTEGER
  entry_price TEXT
  leverage TEXT
  initial_margin TEXT
  accumulated_funding TEXT  -- >0 = dibayar oleh trader
  fees_paid TEXT
  realized_pnl TEXT
  tp_price TEXT NULL
  sl_price TEXT NULL
  liquidation_price TEXT NULL
  opened_at INTEGER
  closed_at INTEGER NULL
  close_reason TEXT NULL    -- manual|tp|sl|liquidation|funding_reject

order_events              -- lifecycle audit, append-only
  seq INTEGER PK AUTOINCREMENT
  order_id TEXT
  type TEXT                 -- created|validated|rejected|opened|filled|partially_filled|cancelled|tp_set|sl_set|tp_triggered|sl_triggered
  detail_json TEXT
  ts INTEGER

position_events           -- lifecycle posisi, append-only
  seq INTEGER PK AUTOINCREMENT
  position_id TEXT
  type TEXT                 -- opened|increased|reduced|flipped|closed|liquidated|funding_applied|margin_changed
  detail_json TEXT
  ts INTEGER
```

### Accounting

```
domain_events            -- OUTBOX transaksional (Phase 5, ADR 0009)
  seq INTEGER PK AUTOINCREMENT   -- URUTAN GLOBAL monoton untuk realtime
  account_id TEXT FK
  type TEXT              -- order.created | position.closed | funding.applied | ...
  aggregate_type TEXT    -- account | order | position | fill | ledger
  aggregate_id TEXT NULL
  command_id TEXT NULL   -- perintah yang menghasilkan event (audit)
  data_json TEXT
  ts INTEGER
  -- append-only (trigger domain_events_no_update/_no_delete)

market_recording_sessions -- sesi rekaman pasar (Phase 8, ADR 0011)
  id TEXT PK
  source TEXT            -- live | simulation
  contracts_json TEXT
  status TEXT            -- recording | completed | aborted
  started_at INTEGER
  ended_at INTEGER NULL
  metadata_json TEXT

market_observations      -- rekaman observasi pasar, APPEND-ONLY
  seq INTEGER PK AUTOINCREMENT   -- URUTAN KANONIK replay (bukan timestamp)
  session_id TEXT FK
  contract TEXT
  kind TEXT              -- mark | quote | funding | candle
  source_timestamp_ms INTEGER    -- jam exchange
  observed_at_ms INTEGER         -- jam lokal (menggerakkan VirtualClock)
  dedupe_key TEXT UNIQUE -- identitas SUMBER
  data_json TEXT         -- nilai finansial sebagai string
  created_at INTEGER
  -- trigger market_observations_no_update/_no_delete

trade_commands           -- idempotensi tingkat PERINTAH (Phase 3, ADR 0007)
  command_id TEXT PK       -- kunci idempotensi yang dikirim pemanggil
  kind TEXT               -- submit_order | evaluate_order | cancel_order
  account_id TEXT FK
  order_id TEXT NULL FK   -- diikat sejak awal agar retry dapat direkonstruksi
  request_hash TEXT NULL  -- sidik jari payload; mendeteksi commandId + payload berbeda
  created_at INTEGER

accounts
  id TEXT PK
  name TEXT
  mode TEXT                 -- live | simulation | replay
  base_currency TEXT        -- "USDT"
  initial_balance TEXT
  created_at INTEGER
  reset_at INTEGER NULL

-- Saldo adalah CACHE dari ledger. Boleh di-rebuild dari ledger kapan saja.
account_balances
  account_id TEXT PK
  wallet_balance TEXT
  used_margin TEXT
  reserved_margin TEXT
  realized_pnl TEXT
  fees_paid TEXT
  funding_paid TEXT
  updated_at INTEGER

ledger                   -- APPEND-ONLY. Sumber kebenaran kebenaran saldo.
  seq INTEGER PK AUTOINCREMENT
  account_id TEXT FK
  ts INTEGER
  type TEXT               -- deposit|withdrawal|reset|pnl_realized|fee|funding|margin_lock|margin_release|liquidation_loss|adjustment
  amount TEXT             -- signed delta wallet_balance, 8 dp kanonik
  margin_delta TEXT       -- signed delta used_margin (refinement Phase 1)
  reserved_delta TEXT     -- signed delta reserved_margin (refinement Phase 1)
  balance_after TEXT      -- wallet_balance setelah entri ini
  ref_type TEXT NULL      -- order|fill|position|funding_tick|admin
  ref_id TEXT NULL
  idempotency_key TEXT UNIQUE
  meta_json TEXT
```

Aturan ledger:
- Tidak ada `UPDATE`/`DELETE`. Koreksi = entri baru bertipe `adjustment`.
- Immutability ditegakkan **di level database** oleh trigger
  `ledger_no_update` / `ledger_no_delete` (migrasi `0001_ledger_append_only.sql`),
  bukan hanya konvensi repository.
- Setiap entri punya `idempotency_key` (mis. `funding:BTC_USDT:1789920000:pos123`).
  Submit ulang dengan kunci sama mengembalikan entri lama tanpa mutasi saldo.
- `balance_after` memungkinkan deteksi korupsi: rebuild dari nol dan bandingkan.
- **Refinement Phase 1:** `margin_lock`/`margin_release` menggerakkan `used_margin`
  lewat kolom eksplisit `margin_delta`, bukan `meta_json.delta`. Tipe `margin_*`
  wajib `amount = 0`, sehingga invariant `Σ amount = wallet_balance` tetap terjaga.
  Alasannya: rebuild saldo tidak boleh bergantung pada parsing JSON.
- Semantik tanda: `account_balances.fees_paid` = `-Σ amount` untuk `type='fee'`, dan
  `funding_paid` = `-Σ amount` untuk `type='funding'`. Positif = trader membayar.
  Karena `maker_fee_rate` Gate.io selalu negatif, rebate membuat `fees_paid` negatif.
- `market_events` juga append-only (trigger `market_events_no_update/_no_delete`).

### Strategy / Jev (skema disiapkan, belum dipakai)

```
feature_snapshots
  id TEXT PK
  contract TEXT
  interval TEXT
  t INTEGER
  features_json TEXT
  engine_version TEXT
  created_at INTEGER

jev_evaluations
  id TEXT PK
  contract TEXT
  interval TEXT
  t INTEGER
  p_trend TEXT
  p_momentum TEXT
  p_reversal TEXT
  btc_regime TEXT
  confidence TEXT
  model_version TEXT
  inputs_json TEXT
  created_at INTEGER

decisions
  id TEXT PK
  jev_evaluation_id TEXT NULL FK
  contract TEXT
  action TEXT               -- enter|exit|hold|reduce
  direction TEXT NULL
  size INTEGER NULL
  leverage TEXT NULL
  tp_price TEXT NULL
  sl_price TEXT NULL
  risk_json TEXT
  engine_version TEXT
  created_at INTEGER

account_config
  account_id TEXT PK
  default_leverage TEXT
  max_leverage TEXT
  max_position_notional TEXT
  risk_per_trade_pct TEXT
  updated_at INTEGER
```

### Relasi inti

```
contracts 1─∞ orders 1─∞ fills
contracts 1─∞ positions 1─∞ fills
accounts  1─∞ orders / positions / ledger / account_config
orders    1─∞ order_events
positions 1─∞ position_events
candles   ∞─1 contracts
decisions ∞─1 jev_evaluations   (nullable)
ledger.ref_id → orders.id | positions.id | fills.id  (polymorphic, tanpa FK)
```

Polymorphic `ref_id` sengaja tanpa FK (pola sama seperti `routing.modelId` di
piastra). Integritasnya dijaga di repository layer + test.

### Runtime risiko (Phase 4)

- `positions.tp_price` / `sl_price` diisi dari `OrderIntent` saat posisi dibuka
  atau di-flip. `liquidation_price` tidak dipersist (dihitung runtime dari model
  likuidasi, yang bisa berubah).
- `positions.close_reason` kini juga bernilai `take_profit` / `stop_loss` /
  `liquidation` (selain `order` / `flip` / `manual`).
- Fill penutupan paksa memakai `order_id = NULL` dengan
  `is_liquidation = 1` atau `is_tp_sl = 1`.
- Defisit insolvensi dicatat sebagai entri ledger `liquidation_loss` dengan
  `amount` positif (diampuni simulator) dan `meta.deficit`; tidak ada tabel baru.
- `trade_commands.kind` bertambah `process_mark` dan `settle_position`.
- Funding dicatat sebagai entri ledger `funding` dengan
  `ref_type = 'funding_tick'`, `ref_id = positionId`, dan kunci idempotensi
  `funding:{contract}:{fundingTimestampMs}:{positionId}`.

### Semantik reservasi (Phase 3)

- `orders.reserved_margin` adalah pandangan PER-ORDER; `account_balances.reserved_margin`
  adalah cache akun. Keduanya harus selalu cocok:
  `account_balances.reserved_margin == Σ orders.reserved_margin` untuk order
  berstatus `open`/`partially_filled` dengan limit gtc/post_only.
- Order `filled`/`cancelled`/`rejected` tidak pernah menahan reservasi (`= 0`).
- `used_margin` = Σ `positions.initial_margin` untuk posisi `open`.
- Perpindahan reservasi → margin posisi menulis SATU entri ledger dengan
  `reserved_delta` negatif dan `margin_delta` positif, `amount = 0`.

## Invariants yang harus selalu benar

1. `Σ ledger.amount` untuk `type ∈ {deposit, withdrawal, reset, pnl_realized, fee, funding, liquidation_loss, adjustment}` = `account_balances.wallet_balance`.
2. `account_balances.used_margin` = `Σ positions.initial_margin` untuk posisi `open`.
3. `Σ fills.size` per order = `orders.filled_size`; `filled_size ≤ size`.
4. Untuk setiap posisi `closed`: `realized_pnl` = `Σ fills.realized_pnl` + `Σ funding` − `Σ fees`.
5. `size ≥ 0` di semua tabel; arah disimpan di `direction`/`side`, bukan tanda.
6. `position.size` setelah fill tidak pernah negatif — flip harus jadi close + open baru
   (dua baris posisi atau satu posisi dengan `position_events)`.
7. Tidak ada `fill` bertimestamp lebih awal dari `position.opened_at`.
8. Ledger tidak pernah punya dua entri dengan `idempotency_key` sama.

## Tabel riset (Phase 9)

### `feature_snapshots` (Phase 1, dilengkapi migrasi 0008)

Menyimpan `FeatureSnapshot` per candle tertutup. Kolom: `id`, `contract`,
`interval`, `t` (open time candle, ms), `features_json`, `engine_version`
(= `featureVersion`), `created_at`.

Unique index `feature_snapshots_unique_idx` pada
`(contract, interval, t, engine_version)` → idempoten per candle & versi.
`id` diturunkan deterministik (`fs:<contract>:<interval>:<t>:<version>`), bukan
UUID, supaya replay menghasilkan baris identik.

### `scanner_results` (migrasi 0008)

Menyimpan `ScannerResult` per candle tertutup yang lolos warmup. Kolom: `id`,
`contract`, `interval`, `t` (waktu tutup candle, ms), `feature_version`,
`scanner_version`, `scanner_config_hash`, `status`, `direction`, `setup_type`,
`signal`, `facts_json`, `reason_codes_json`, `created_at`.

Unique index `scanner_results_unique_idx` pada
`(contract, interval, t, feature_version, scanner_version, scanner_config_hash)`.

Keduanya data **riset/analitik**. Bukan `domain_events` (outbox ekonomi, ADR
0009) dan bukan `decisions` (keputusan ekonomi: ukuran, leverage, SL/TP — belum
ada di Phase 9). Tidak ada peristiwa ekonomi yang ditulis lapisan ini, dan hash
ekonomi replay terbukti tidak berubah saat analytics aktif.

### `decisions` (Phase 1, dibangun ulang di migrasi 0009)

Menyimpan keputusan otonom Phase 10, termasuk SKIP. Kolom kunci: `id`,
`account_id`, `contract`, `interval`, `candle_close_t`, `action`, `direction`,
`size_text`, `leverage`, `reference_price`, `tp_price`, `sl_price`, `notional`,
`initial_margin`, `risk_amount`, `risk_percent`, `reward_amount`,
`reward_risk_ratio`, `stop_distance`, `stop_distance_pct`, `reasons_json`,
`risk_json`, `jev_evaluation_id` (cadangan untuk komposisi Jev),
`decision_version`, `feature_version`, `scanner_version`, `scanner_config_hash`,
`risk_policy_version`, `risk_policy_hash`, `created_at`.

Unique index `decisions_unique_idx` pada `(account_id, contract, interval,
candle_close_t, decision_version, scanner_version, scanner_config_hash,
risk_policy_hash)` → idempoten; id diturunkan deterministik (`dec:` + kunci).

`risk_json` menyimpan `AccountRiskState` (input risiko); kolom rencana menyimpan
TradePlan. Semua nilai uang berupa string.

**Bukan** tabel ekonomi: lapisan keputusan tidak menulis `orders`, `fills`,
`positions`, atau `ledger` (dibuktikan test 100 evaluasi). Tabel ini diperluas
dari placeholder Phase 1 alih-alih diduplikasi karena belum pernah ditulis dan
tidak punya `account_id`/waktu candle/reason codes.

### `decision_executions` (migrasi 0010)

Linkage eksekusi otonom. Kolom: `id`, `decision_id` (**unik**), `account_id`,
`command_id`, `order_id`, `position_id`, `status`, `error_code`,
`error_detail`, `planned_reference`, `actual_fill_price`, `attempted_at`,
`updated_at`. Status: `pending|submitted|filled|resting|rejected|failed|skipped`.

Bukan tabel ekonomi: tidak menyimpan ulang order/fill, dan tidak ada baris
ekonomi yang ditulis bila gate OFF.

### `trade_records` (migrasi 0010)

**DERIVED** — materialisasi riset siklus hidup trade otonom, dibangun dari
sumber kanonik (orders/fills/positions/ledger) dan boleh dibangun ulang. Kolom:
identitas trade/keputusan/kontrak/sisi, waktu keputusan/entry/exit,
`planned_reference`, `actual_entry`, `size`, `leverage`, `stop_loss`,
`take_profit`, `planned_risk`, `actual_initial_risk`, `gross_realized_pnl`,
`fees`, `funding`, `net_pnl`, `exit_reason`, `mae`, `mfe`, `mae_r`, `mfe_r`,
`r_multiple`, `holding_duration`, versi/hash (feature/scanner/decision/risk/
evaluation), `created_at`.

Unik per `decision_id` → satu trade per keputusan. Tidak dipakai logika ekonomi
apa pun. Semua nilai uang berupa string.

### `jev_evaluations` (Phase 1, dibangun ulang di migrasi 0011)

Satu baris per evaluator, sekaligus **cache**. Kolom: `id`, `input_hash`,
`contract`, `interval`, `t`, `direction`, `evaluator`, `evaluator_version`,
`prompt_version`, `schema_version`, `provider`, `model`, `probability`,
`regime_json`, `confidence`, `status`, `reason_codes_json`, `output_json`,
`metadata_json`, `inputs_json`, `latency_ms`, `input_tokens`, `output_tokens`,
`created_at`.

Unique index `jev_evaluations_cache_idx` pada `(input_hash, evaluator,
evaluator_version, prompt_version, schema_version, provider, model)` → identitas
cache. Mengubah prompt/model menghasilkan baris baru, bukan menimpa.

Tidak menyimpan rahasia: `metadata_json` hanya metadata aman.

### `treatment_results` (migrasi 0011)

Hasil perlakuan per kandidat (audit A/B, bukan tabel ekonomi). Kolom: `id`,
`input_hash`, `contract`, `interval`, `t`, `direction`, `treatment_kind`,
`treatment_version`, `treatment_config_hash`, `status`
(`allow|veto|unavailable|invalid`), `reasons_json`, `evaluations_json`,
`created_at`. Unik per `(input_hash, treatment_version, treatment_config_hash)`.

### `candidate_outcome_labels` (migrasi 0012)

Label hasil OFFLINE (`outcome-label-v1`). Kolom: `id`, `input_hash`, `contract`,
`interval`, `t`, `direction`, `label_version`, `price_source`, `reference_close`,
`atr14`, `horizons_json`, `labels_json`, `status`, `incomplete_reason`,
`created_at`. Unik per `(input_hash, label_version)`.

**Terpisah total** dari `jev_evaluations`: baris Jev tidak pernah dimutasi dengan
informasi masa depan. Tabel ini hanya dibaca jalur riset offline.
