# crypastra — Arsitektur

Paper-trading terminal untuk crypto USDT perpetual futures. **Hanya uang virtual.**
Tidak ada eksekusi order ke exchange asli, tidak ada private trading API.

Status dokumen: spec awal (pra-implementasi). Semua angka/klaim Gate.io di sini
berasal dari probe empiris 20 Sep 2026 — lihat `docs/gateio-market-data.md`.

---

## 1. Prinsip

1. **Accounting, bukan simulator.** Paper Exchange diperlakukan sebagai sistem
   akuntansi finansial: append-only ledger, idempoten, dapat diaudit, deterministik.
2. **Uang tidak pernah `number`.** Semua besaran moneter = `Decimal` (decimal.js).
   `number` hanya boleh untuk: UI formatting, statistik non-finansial, timestamp.
3. **Market data ≠ trading engine.** Engine tidak tahu Gate.io. Ia tahu
   `MarketDataProvider` dan `MarketEvent`.
4. **Exchange tidak tahu siapa pengirim order.** Manusia, strategy, replay, test →
   semuanya `ValidatedOrder`. Tidak ada field `source` yang mengubah perilaku.
5. **Pure core, tebal di batas.** Matematika margin/PnL/likuidasi = fungsi murni di
   `@crypastra/core`. I/O (WS, DB, HTTP) = adapters.
6. **Satu arah aliran.** Market Data → Market State → Strategy → Jev → Decision/Risk →
   Paper Exchange. Tidak ada panah balik dari Paper Exchange ke Market Data.

## 2. Aliran domain

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ADAPTERS (I/O)                                                            │
│  GateioMarketDataProvider   ReplayMarketDataProvider   SimMarketDataProvider│
└──────────────────────────────┬────────────────────────────────────────────┘
                               │ MarketEvent (ticker | candle | trade | book | mark)
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ MARKET (packages/core)                                                    │
│  MarketState: ticker, mark/index price, book top, candle series,          │
│               contract spec, clock                                        │
│  FeatureEngine: fitur deterministik (EMA, ATR, return, vol, dst.)         │
└──────────────────────────────┬────────────────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ JEV (belum diimplementasikan)                                             │
│  Input: MarketState + FeatureSnapshot                                     │
│  Output: { p_trend, p_momentum, p_reversal, regime, confidence, modelVer } │
│  Jev TIDAK menyentuh order, leverage, saldo, atau akuntansi.              │
└──────────────────────────────┬────────────────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ DECISION / RISK ENGINE                                                    │
│  Konsumen Jev + config deterministic → intent (entry, tp, sl, size, lev)  │
│  Satu-satunya sumber kebijakan leverage & sizing.                         │
└──────────────────────────────┬────────────────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ PAPER EXCHANGE (packages/core + persistence)                              │
│  OrderBook(L2 simulasi) → MatchingEngine → MarginEngine → Ledger          │
│  PositionEngine → LiquidationEngine → FundingEngine → FeeEngine           │
└──────────────────────────────┬────────────────────────────────────────────┘
                               ▼
                        Wallet / Ledger / History
```

## 3. Aturan batas (import rules)

| Paket | Boleh import | Tidak boleh import |
|---|---|---|
| `@crypastra/core` | `decimal.js`, `zod` | fastify, bun:sqlite, ws, drizzle |
| `@crypastra/adapters` | `@crypastra/core`, `ws` | fastify, drizzle, bun:sqlite |
| `apps/server` | core, adapters, drizzle, fastify, bun:sqlite | — |
| `apps/web` | core (tipe saja) | adapters, server |

`core` tidak boleh punya efek samping jam/lingkungan. Waktu masuk sebagai parameter
(`nowMs`), bukan `Date.now()` di dalam logika akuntansi. Ini yang membuat replay
dan test deterministik.

## 4. Tiga mode, satu engine

| Mode | Provider | Arti |
|---|---|---|
| LIVE | `GateioMarketDataProvider` | data publik Gate.io USDT perpetual |
| SIMULATION | `SimMarketDataProvider` | injeksi harga manual / acak terkendali |
| REPLAY | `ReplayMarketDataProvider` | candle historis dari DB, diputar pada clock virtual |

Ketiganya memproduksi `MarketEvent` identik dan memberi `Clock`. Engine hilir tidak
tahu mode. Syarat implementasi: **semua** jalur waktu (funding tick, TP/SL check,
liquidation check, candle roll) membaca dari `Clock`, bukan `Date.now()`.

Aturan clock:
- LIVE: `clock.nowMs()` = waktu server (dengan offset terhadap `time_ms` payload).
- REPLAY: `clock.nowMs()` = waktu candle yang sedang diputar.
- Order di REPLAY dilarang memiliki timestamp masa depan.

## 5. Kontrak perpetual — pemodelan

Satu kontrak (mis. `BTC_USDT`) dimodelkan oleh `ContractSpec` dari
`GET /futures/usdt/contracts`. Yang **wajib** ada (semua terverifikasi ada di API):

| Field Gate.io | Pakai untuk | Contoh BTC_USDT |
|---|---|---|
| `quanto_multiplier` | konversi `size` (kontrak) → kuantitas BTC | `0.0001` |
| `order_size_min/max` | validasi qty | `1` / `12000000` |
| `order_price_round` | tick size harga | `0.1` |
| `mark_price_round` | pembulatan mark price | `0.01` |
| `leverage_min/max` | batas leverage | `1` / `200` |
| `maintenance_rate` | MMR likuidasi (isolated) | `0.003` |
| `maker_fee_rate` / `taker_fee_rate` | fee | `-0.0001` / `0.00075` |
| `funding_interval` | periode funding (detik) | `28800` (8 jam) |
| `funding_rate` / `funding_next_apply` | jadwal & tarif funding | — |
| `order_size_round` (bila ada) | pembulatan qty | cek per-kontrak |
| `status` | hanya `trading` yang boleh ditrade | `trading` |

**Penting:** `quanto_multiplier` sangat heterogen antar kontrak (0.0001 untuk BTC,
1 untuk banyak altcoin, 0.000001 untuk meme coin). Jangan hardcode 0.0001. Jangan
asumsikan `size * multiplier = qty_base` berlaku seragam — verifikasi per kontrak.

Notional (USDT) = `size × quanto_multiplier × price`.

## 6. Margin isolated

Paper exchange memakai **isolated margin** per posisi:

```
notional_entry   = size × quanto_multiplier × entry_price
initial_margin   = notional_entry / leverage        (dibulatkan ke atas, 8 dp)
maintenance      = size × quanto_multiplier × mark_price × maintenance_rate
unrealized_pnl   = size × quanto_multiplier × (mark_price − entry_price) × dir
                   dir = +1 LONG, −1 SHORT
equity_position  = initial_margin + unrealized_pnl − accumulated_funding − fees_paid
liquidation      ≈ entry_price − dir × (initial_margin − maintenance) / (size × multiplier)
```

Rumus likuidasi di atas adalah **model internal paper exchange**, bukan replika
formula Gate.io. Gate.io bisa memakai formula berbeda (termasuk komponen fee
taker untuk menutup posisi). Ini assumption A6 di `PLAN.md`.

Semantik akun:
- `wallet_balance` = saldo kas (realized saja, tanpa unrealized)
- `used_margin` = Σ `initial_margin` posisi terbuka
- `available_balance` = `wallet_balance − used_margin − Σ reserved_order_margin`
- `equity` = `wallet_balance + Σ unrealized_pnl`
- `margin_ratio` = `used_margin / equity`

## 7. Mark price, bukan last price

`mark_price` dipakai untuk: unrealized PnL, likuidasi, funding, dan **trigger TP/SL**.
`last_price` dipakai untuk: matching order market/limit (fill) dan tampilan candle.

Konsekuensi desain: engine butuh `mark_price` yang selalu segar. Di Gate.io mark price
**tidak punya channel WS sendiri** (`futures.mark_price` ditolak — lihat
`docs/gateio-market-data.md`). Mark price datang dari `futures.tickers` (field
`mark_price`) dan REST kontrak. Ini harus ditangani eksplisit: **mark price bisa
lebih lambat dari last price**, dan itu mempengaruhi kapan likuidasi dievaluasi.

## 8. Event & idempotensi

Semua event punya `seq` (monoton) dan `id` deterministik. Ingest event pasar
idempoten berdasarkan `(provider, channel, contract, eventTs, discriminator)`:

- candle: `(contract, interval, t)` — `w:false` final menimpa `w:true` parsial
- trade: `id` trade dari exchange
- book_update: `U`/`u` sequence — gap `U > last_u + 1` wajib memicu resync snapshot
- order/fill/ledger (internal): `seq` internal

Replay wajib deterministik: memutar ulang event yang sama dengan starting state
yang sama harus menghasilkan ledger yang identik byte-per-byte (setelah normalisasi
timestamp eksekusi).

## 8b. Batas aplikasi (Phase 5)

```
klien HTTP/WS
   ↓  (validasi zod, tanpa matematika finansial)
api/app.ts  →  service (AccountService, OrderService, PositionService,
                        MarkToMarketService)
   ↓  (satu transaksi BEGIN IMMEDIATE)
repository + ledger + outbox domain_events
```

- Rute TIDAK menghitung PnL/fee/margin dan TIDAK memutasi tabel langsung.
- `MarketSnapshotProvider` adalah sumber nilai pasar milik server; Phase 5 memakai
  implementasi in-memory, Phase 6 menggantinya dengan MarketState live tanpa
  mengubah pemanggil.
- Realtime memakai outbox `domain_events` (urutan global `seq`), bukan gabungan
  urutan tabel. Detail protokol: `docs/REALTIME.md`; kontrak HTTP: `docs/API.md`.
- Peristiwa domain (durable) dipisahkan dari peristiwa pasar (ephemeral).

## 8c. Runtime pasar live (Phase 6)

```
Gate.io public futures WS
   ↓  GateioMarketDataProvider (reconnect backoff, resubscribe, status)
normalized MarketEvent (ticker | book_ticker | candle | book_update)
   ↓
MarketRuntime ──┬── MarketState (mark/last/index, funding, top-of-book, candle)
                ├── DepthBook lokal (hanya kontrak terkonfigurasi; SYNCING/SYNCED/UNSYNCED)
                ├── stream pasar EPHEMERAL (tanpa seq, boleh di-coalesce)
                └── pemroses risiko berkadens (mark TERBARU per kontrak)
                        ↓
                LiveRiskProcessor → MarkToMarketService → posisi/ledger
```

- Normalisasi tetap deterministik; hanya ingesti yang nondeterministik.
- Peristiwa pasar TIDAK pernah masuk `domain_events`.
- Buku berlubang tidak pernah dipakai untuk eksekusi.
- Mark basi menonaktifkan aksi risiko (staleness terhadap jam exchange).

## 8d. Rekaman & replay (Phase 8)

```
Gate ──► parser ──► observasi ternormalisasi ──► MARKET_OBSERVATIONS (append-only)
                                   │
                                   └──► MarketRuntime ──► MarketState
MARKET_OBSERVATIONS ──► ReplayMarketDataProvider ──► SAME MarketRuntime
                                                          ▼
                                                  SAME Paper Exchange
```

- **Satu mesin ekonomi.** Tidak ada mesin/replay PnL/likuidasi kedua.
- Replay masuk lewat batas market-data yang sama (`MarketDataProvider`).
- Rekaman pasar (`market_observations`) TIDAK sama dengan peristiwa domain
  (`domain_events`): yang satu data pasar, yang lain peristiwa ekonomi.
- Isolasi: sumber dibaca dari DB rekaman, ekonomi ditulis ke DB terisolasi.

Detail: `docs/REPLAY.md`, ADR 0011.

## 9. UI (ditunda)

Layout desktop yang diminta (dipertahankan sebagai requirement, lihat
`docs/PRODUCT.md`):

```
Navigation
├── Wallet / account summary
├── Watchlist
├── Main market area (symbol header, stats, candlestick)
├── Trading / Jev side panel
└── Bottom workspace (Positions | Orders | History | Ledger | Jev Decisions)
```

Design language: "Modern Soft Trading Terminal". Dark default + light opsional,
dark navy/charcoal, soft/neumorphic depth tipis, shadow tertahan, radius besar
terkontrol, hijau/merah **hanya** untuk makna finansial, hirarki tipografi kuat,
nyaman untuk sesi panjang, bukan dashboard admin generik, tanpa gradien/glassmorphism
berlebih, tanpa estetika neon crypto.

Keputusan visual reference: **tidak ada file gambar visual reference yang ditemukan**
di `/home/esb/project/crypastra-trading` (repo kosong saat inspeksi) maupun di `~/Downloads`/`~/Desktop`
(direktori tidak ada). Yang dirujuk user sebagai "attached visual references" tidak
tersedia di filesystem. Deskripsi tekstual di atas dipakai sebagai kontrak desain.
Kalau ada file referensi, taruh di `docs/reference/` sebelum Phase 7.

## Lapisan intelijen pasar (Phase 9)

```
closed candle 5m (LIVE / REPLAY, jalur SAMA)
  → FeatureEngine (packages/core/src/analytics/features.ts, murni)
  → FeatureSnapshot
  → Hard Scanner (packages/core/src/analytics/scanner.ts, murni)
  → ScannerResult { candidate | skip, direction, setupType, facts, reasonCodes, signal }
  → AnalyticsService (apps/server/src/analytics) → feature_snapshots + scanner_results
```

Batasnya keras: inti analytics tidak boleh mengimpor DB, repository, service
ekonomi, saldo, atau leverage (ditegakkan guard impor). Mark/bid/ask tidak
dipakai untuk fitur V1 — itu milik eksekusi/risiko. Scanner bersifat
observasional: kegagalannya tidak menghentikan ingest pasar atau paper trading.

Detail: `docs/FEATURES.md`, `docs/SCANNER.md`, ADR 0012.

## Lapisan keputusan (Phase 10)

```
Feature Engine → Scanner → Candidate/Signal
                              ↓
                        Decision Engine  (packages/core/src/decision/engine.ts, murni)
                              ↓
                          Risk Engine    (risk-v1, kebijakan ter-hash)
                              ↓
                          TradePlan
                              │
                              └── STOP: Phase 10 tidak mengirim ke OrderService
```

Input murni: FeatureSnapshot, ScannerResult, `DecisionMarketContext`,
`AccountRiskState`, `ContractSpec`, `RiskPolicy`. Dilarang DB/repository/service
ekonomi/waktu/acak (guard impor). Scanner tidak melihat wallet/posisi/margin/
leverage; Risk Engine tidak menghitung ulang indikator.

Perakitan ada di `apps/server/src/decision/` (`DecisionService` +
`DecisionCoordinator`), dipakai IDENTIK oleh live dan replay. Live default OFF
(`CRYPASTRA_DECISIONS=1`). Tidak ada order yang ditempatkan.

Detail: `docs/DECISIONS.md`, `docs/RISK.md`, ADR 0013.

## Eksekusi otonom & evaluasi (Phase 11)

```
TradePlan (disetujui)
   ↓  Execution Gate (CRYPASTRA_DECISIONS=1 + CRYPASTRA_EXECUTION=1 + akun)
TradeExecutionService  →  OrderService (PAPER)  →  Paper Exchange
   ↓                                              ↓
decision_executions                        positions/ledger (berkembang)
                                                  ↓
                                        AutonomousTradeTracker
                                                  ↓
                                          trade_records (DERIVED)
                                                  ↓
                                          evaluasi baseline (evaluation-v1)
```

Gate OFF = lapisan inert (tidak memanggil OrderService, tidak menulis apa pun).
Exit tetap milik Paper Exchange; tidak ada mesin exit kedua. Tidak ada endpoint
privat Gate, kredensial, Jev, atau LLM.

Detail: `docs/EXECUTION.md`, `docs/EVALUATION.md`, ADR 0014.

## Perlakuan intelijen (Phase 12)

```
Scanner candidate
      ↓
CandidateTreatment  (NoTreatment = CONTROL | JevTreatment = TREATMENT)
      ↓
JevEvaluation[] → kebijakan veto deterministik (jev-veto-v1)
      ↓ allow                        ↓ veto/unavailable/invalid
DecisionEngine + risk-v1            berhenti (tidak ada keputusan/eksekusi)
      ↓
Paper Exchange (tidak berubah)
```

Jev hanya menyuplai probabilitas; ia tidak menentukan arah, ukuran, leverage,
SL/TP, atau eksekusi. Kode perlakuan tidak boleh mengimpor service ekonomi, dan
`risk-v1` tidak mengimpor Jev (guard impor). Tanpa perlakuan, alur kontrol persis
seperti Phase 11.

Detail: `docs/JEV.md`, `docs/EXPERIMENTS.md`, ADR 0016.

## Pipeline riset (Phase 13)

```
RECORD ONLY / RECORD+COLLECT        BACKFILL                REPLAY
  Gate publik → MarketRecorder       rekaman → fitur/scanner   nol jaringan
        ↓                            → hash kandidat            ↓
  observasi (mark/quote/             → cache → ambil hilang   evaluasi tercache
  funding/candle)                    → persist                      ↓
        ↓                                                          ↓
  analitik (fitur → scanner) ──→ antrean Jev terbatas ──→ evaluasi tersimpan
        ↓                                                          ↓
  perlakuan (cache saja) ──────────────────────────────────────────┘
        ↓
  (OFFLINE) label hasil → dataset export / quality
```

Kolektor Jev tidak pernah memblokir ingest pasar. Label hasil hanya ada di jalur
riset offline dan tidak dapat dibaca perlakuan/keputusan/eksekusi (guard impor).

Detail: `docs/DATASET.md`, `docs/LABELS.md`, `docs/COLLECTION.md`, ADR 0017.
