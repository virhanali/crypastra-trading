# Status proyek

Terakhir diperbarui: 2026-09-20.

## Fase saat ini: Phase 8 — rekaman & replay deterministik (SELESAI)

Phase 0–7B tetap utuh: seluruh 631 test lamanya masih hijau tanpa diubah.

## Bukti verifikasi terakhir

```
bun test        -> 660 pass, 0 fail  (631 sebelumnya + 29 Phase 8)
bun run check   -> core build OK, adapters check OK, server check OK
pemindaian unused/dead-code -> bersih (core, adapters, server)
smoke:live (opt-in) -> mark segar ~1.7s, bid < ask, candle 5m, funding OK
smoke:paper (opt-in) -> order PAPER terisi di kutipan publik, integritas OK
smoke:live-api (opt-in) -> dogfood HTTP live: fill di kutipan Gate, TP/SL, close,
                           ledger rekonsiliasi persis, integritas OK
smoke:record-replay (opt-in) -> rekam 554 observasi live, replay 2x hash identik
bun run check   -> termasuk svelte-check: 0 error, 0 warning
bun run build:web -> ~310 kB (gzip 104 kB)
bun run db:migrate (DB kosong, 2x) -> 19 tabel, 8 migrasi, idempoten
trigger append-only: ledger_*, market_events_*, domain_events_*, market_observations_*
upgrade DB Phase 1 berisi data -> migrasi 0002 sukses, baris lama utuh
bun run probe   -> REST + WS Gate.io hidup (candle, ticker, mark age ~0.4s)
PRAGMA journal_mode = wal
trigger append-only: ledger_*, market_events_*
kolom finansial bertipe REAL/NUMERIC: 0
```

## Yang benar-benar ada dan terbukti jalan

1. Monorepo Bun (`packages/core`, `packages/adapters`, `apps/server`, `tools/`, `tests/`).
2. `@crypastra/core` — money (decimal.js); matematika exchange murni:
   `contract-math` (satuan eksplisit, eksposur bertanda), `rounding` (kebijakan
   terpusat), `fee` (termasuk rebate) + funding, `pnl`, `margin`,
   `liquidation` (`LiquidationModel`), `tpsl` (trigger eksplisit), `matching`
   (predikat + konsumsi level); `ContractSpec` (dengan `enableDecimal`), ledger
   in-memory, `MarketState`, `Clock`, error domain bertipe.
3. `@crypastra/adapters` — `GateioMarketDataProvider` (REST + WS nyata), parser murni,
   `SimMarketDataProvider`.
4. `@crypastra/server` — skema 16 tabel (Drizzle + `bun:sqlite`, WAL); migrasi `0000`
   (skema) + `0001` (trigger append-only) + `0002` (`enable_decimal`) + `0003`
   (`trade_commands`); repository `contracts`, `candles`, `market_events`,
   `accounts`, `ledger`, `orders`, `fills`, `positions`, `order_events`,
   `position_events`, `trade_commands`; `OrderService` (submit/evaluate/cancel);
   `rebuildBalances`/`verifyBalances`/`integrityReport`; CLI `bun run db:migrate`.
5. `tools/probe-gateio.ts` — verifikasi live read-only ke Gate.io.

## Keputusan persistensi yang dikunci (ADR 0005)

- Uang = TEXT 8 dp kanonik; harga/rate/spec = TEXT eksak (bisa 11 dp).
- Konversi hanya di `db/decimal-codec.ts`; `Number`/`parseFloat`/`toFixed` dilarang
  di `apps/server` (ditegakkan test).
- Transaksi memakai `BEGIN IMMEDIATE` (pengganti `SELECT FOR UPDATE` di SQLite).
- `ledger` dan `market_events` append-only **di level database** (trigger).
- `seq` (INTEGER AUTOINCREMENT) adalah urutan total deterministik untuk replay.
- `fees_paid`/`funding_paid` = biaya kumulatif (positif = trader membayar; rebate
  membuatnya negatif).
- `schema.ts` hanya boleh `import type` dari core, karena drizzle-kit berjalan CJS.

## Keputusan rekaman & replay (ADR 0011)

- Observasi ternormalisasi (`mark`/`quote`/`funding`/`candle`) adalah satu-satunya
  bentuk tersimpan; replay tidak mem-parse ulang payload Gate.
- `observedAtMs` = jam LOKAL (bukan jam exchange) supaya VirtualClock tidak mundur
  dan staleness replay identik dengan live.
- Urutan kanonik = `seq`; waktu di-clamp monoton untuk data tak terurut.
- `mark` selalu direkam; `quote`/`funding` hanya saat berubah; depth tidak direkam.
- Isolasi dua koneksi: sumber baca DB rekaman, ekonomi tulis DB terisolasi.
- ID deterministik di jalur ekonomi replay; `idempotencyKey` dikecualikan dari
  sidik jari kanonik.
- `Ticker.fundingRate` nullable (adapter tidak lagi mengarang "0").
- `LiveRiskProcessor` di-rename `MarketRiskProcessor` (source-agnostic).

## Keputusan terminal (Phase 7B)

- Preview memakai decimal.js (lib sama dengan core), bukan aritmetika float;
  margin/fee dibulatkan ke atas 8 dp seperti core.
- Preview BUKAN mesin exchange kedua: tanpa transisi posisi, settlement PnL,
  likuidasi, funding, atau mutasi dompet.
- Input finansial tetap string mentah; size adalah cacah kontrak bulat.
- Status pengiriman eksplisit; `outcome_uncertain` tidak pernah ditampilkan
  sebagai "gagal", payload dibekukan, retry memakai commandId + payload sama.
- Close hanya penuh (backend belum mendukung partial); ditolak bila kutipan
  eksekusi tidak tersedia.
- Tidak ada pelepasan margin / penghapusan baris optimistis di klien.

## Keputusan terminal (Phase 7A)

- Stack: Svelte 5 (runes) + Vite + Tailwind 4 + lightweight-charts (bukan React,
  bukan widget hosted TradingView). Browser TIDAK pernah menyentuh Gate.io.
- Token desain terpusat di `app.css`; tema terang disiapkan.
- Nilai finansial tetap string; kolom memakai desimal tetap; absen → `—`.
- Status feed dari kesehatan pasar server (bukan status WebSocket browser).
- Peristiwa domain dipakai untuk memicu reload akun (debounce), peristiwa pasar
  mengalir ke store pasar dengan coalescing per frame.
- `commandId` dibuat sekali per aksi dan dipakai ulang saat retry.
- Read model baru: `/api/v1/market/state`, `/api/v1/market/candles`.

## Keputusan runtime pasar live yang dikunci (ADR 0010)

- `futures.book_ticker` = sumber kutipan eksekusi; `order_book_update` HANYA untuk
  kedalaman lokal (payload-nya delta/perubahan, bukan best bid/ask).
- Kelas langganan CORE/CANDLE/DEPTH; kedalaman hanya untuk kontrak terkonfigurasi.
- Reconnect backoff eksponensial dengan timer dapat disuntik; resubscribe dari
  state keinginan (tanpa langganan ganda).
- MarketState menyimpan mark/last/index/funding/top-of-book/candle dengan waktu
  exchange dan waktu terima TERPISAH; field absen tetap null.
- Buku berlubang → UNSYNCED; eksekusi tidak pernah memakai buku belum sinkron.
- Pemroses risiko berkadens dengan coalescing (mark terbaru per kontrak).
- Id perintah runtime deterministik dari identitas mark (bukan UUID).
- Peristiwa pasar ephemeral: tanpa `seq`, tidak pernah durable, boleh di-coalesce.
- Persistensi: hanya candle 5m tertutup.

## Keputusan API & realtime yang dikunci (ADR 0009)

- Rute HTTP hanya memanggil service; tidak ada matematika finansial di rute.
- Semua nilai finansial JSON = STRING (ditegakkan test per-endpoint).
- `commandId` + `request_hash`: retry aman, payload berbeda → 409.
- Outbox `domain_events` transaksional dengan urutan GLOBAL `seq` untuk resume.
- `GET /summary` mengembalikan `latestEventSeq` untuk menutup celah snapshot→subscribe.
- Pengiriman at-least-once; klien dedupe via `seq`.
- Backpressure: antrean + ambang buffer socket; klien lambat diputus `1013`.
- Outbox hanya untuk peristiwa FINANSIAL; tick pasar adalah aliran ephemeral (Phase 6).
- `MarketSnapshotProvider` memisahkan API baca dari nilai pasar klien.

## Keputusan runtime risiko yang dikunci (ADR 0008)

- Unrealized PnL TURUNAN; mark-to-market tidak menulis ledger.
- `equity = wallet + unrealized`; `available` TIDAK memasukkan unrealized profit.
- Mark basi (atau timestamp sumber di masa depan) → tanpa aksi risiko/funding.
- Presedensi: staleness → likuidasi → SL → TP → funding.
- Trigger memakai mark; eksekusi memakai `ExecutionQuote` (LONG di bid, SHORT di
  ask). Gap tidak dipalsukan.
- Settlement isolated: kas dibebani maksimal sebesar margin; defisit dicatat
  sebagai `liquidation_loss` + `insolvent`, bukan dihapus.
- Funding: sekali per (contract, fundingTimestampMs, posisi); inklusif bila
  dibuka tepat pada T; posisi yang ditutup tepat pada T tidak dikenakan.
- Penutupan paksa memakai path settlement internal (bukan `OrderIntent`), dengan
  fill `order_id = NULL` + flag `is_liquidation`/`is_tp_sl`.
- Idempotensi dua lapis: `trade_commands` + kunci ledger deterministik.

## Keputusan siklus order yang dikunci (ADR 0007)

- `OrderIntent` tetap TANPA field asal; `OrderIntentSchema` strict dan test
  membuktikan field asal ditolak. Label produsen hanya `auditSource` (audit).
- Idempotensi per perintah lewat `trade_commands` (klaim atomic di dalam transaksi).
- State machine eksplisit; transisi ilegal melempar; tiap perubahan status → event.
- Order RESTING yang tidak tersentuh snapshot tetap `open` (koreksi bug).
- Reservasi → margin posisi = satu entri ledger (`reservedDelta` −, `marginDelta` +).
- Pelepasan margin proporsional dibulatkan FLOOR (konservatif, konservasi terjaga).
- Order ditolak dipersist untuk audit tanpa efek ekonomi.
- Tidak ada `update()` generik di repository; mutasi finansial lewat metode bernama.

## Keputusan matematika yang dikunci (ADR 0006)

- Satuan ditulis eksplisit; `quanto_multiplier` heterogen (0.0001–10000000).
- Pembulatan dipusatkan di `exchange/rounding.ts`; modul exchange lain dilarang
  memakai `toDecimalPlaces`/`Decimal.ROUND_*`/`.toNumber()` (ditegakkan test).
- Fee = CEIL 8 dp pada amount bertanda → biaya naik, rebate mengecil.
- Harga memakai tick kontrak (sampai 11 dp), bukan 8 dp.
- Likuidasi di belakang `LiquidationModel`; model default `provenance: "simulator"`,
  domain sah `1/leverage > maintenance_rate`; keadaan degenerate → hasil bertipe,
  bukan clamp.
- `enable_decimal` ditambahkan ke `ContractSpec` + kolom DB (migrasi 0002).

## Phase 9 — Feature Engine & Scanner (SELESAI)

- `features-v1`: EMA20/50/200 (seed SMA), RSI14 Wilder (pasar datar = 50),
  MACD 12/26/9, ATR14 Wilder, return 1/3/12, SMA20 volume + rasio, jarak EMA,
  trendStructure, warmup eksplisit. Hanya candle tertutup 5m; tanpa intrabar.
- Inti murni di `packages/core/src/analytics/`; guard impor menolak DB/order/
  ledger/saldo/leverage/waktu/acak. Presisi analitik (tanpa pembulatan 8 dp).
- `scanner-v1`: config-driven, kandidat ≠ sinyal, reasonCodes mesin-baca,
  konteks BTC opsional. Tanpa sizing/leverage/SL/TP/optimasi.
- `AnalyticsService` satu jalur untuk live dan replay; tidak pernah melempar;
  tidak mengubah hash ekonomi (dibuktikan test).
- Persistensi: `feature_snapshots` (unique index per versi) + `scanner_results`
  (migrasi 0008). Hash riset kanonik FNV-1a bebas id/waktu.
- Fixture golden 280 candle → `combinedHash d9f221276d8fc312`.
- Alat opt-in `bun run analyze:recording -- <session> [--db <path>] [--json]`.

## Phase 10 — Decision & Risk Engine (SELESAI)

- `decision-v1` + `risk-v1`: sizing dari anggaran risiko (`equity × 1%`), stop
  dari ATR14 × 2, TP = 2× jarak stop, RR minimum 1.5 setelah pembulatan tick.
- Pembulatan harga protektif arah-sadar: SL menjauh dari risiko (LONG ceil,
  SHORT floor), TP menjauh dari harapan. Sizing memakai jarak stop hasil tick.
- Ukuran dibulatkan KE BAWAH (integer / 8 dp desimal); cap notional 300% equity
  dan cap kontrak menurunkan ukuran saja. Leverage = default kebijakan dijepit
  batas kebijakan (20) dan kontrak; bukan dari keyakinan sinyal.
- Batas: margin ≤ saldo tersedia DAN total margin ≤ 50% equity; maksimum 5
  posisi terbuka, 1 posisi per kontrak; posisi sejenis → skip.
- SKIP dipersist. Idempoten per (akun, kontrak, interval, candle_close_t,
  decision_version, scanner_version, scanner_config_hash, risk_policy_hash).
- Bukti tanpa eksekusi: 100 evaluasi tidak mengubah orders/fills/positions/
  ledger/balances. Live di balik `CRYPASTRA_DECISIONS` (default OFF).
- Replay memakai engine yang sama; dua run → hash keputusan identik, dan hash
  ekonomi replay tidak berubah.
- Fixture golden LONG (BTC_USDT, equity 1000): size 125, notional 1000,
  margin 100, risk 10, reward 20, RR 2, SL 79200, TP 81600.
- Alat opt-in `bun run analyze:decisions -- <session> [--equity 1000] [--json]`.

## Phase 11 — Autonomous PAPER Execution & Evaluation (SELESAI)

- Gate `CRYPASTRA_EXECUTION=1` (default OFF, inert: tidak menulis apa pun).
  Butuh `CRYPASTRA_DECISIONS=1` + akun eksplisit; startup mencetak
  `AUTONOMOUS PAPER EXECUTION: ON|OFF`.
- `TradeExecutionService` memetakan TradePlan → OrderIntent apa adanya dan
  memanggil OrderService PAPER. Command id `auto-entry:<decisionId>`; restart
  aman karena OrderService idempoten pada command id.
- `decision_executions` (unik per keputusan) menyimpan linkage; status
  eksplisit; penolakan ekonomi (`rejected`) dibedakan dari kegagalan sistem
  (`failed`). SKIP tidak dapat dieksekusi (10.000 evaluasi → nol order).
- Keadaan akun dibangun ulang dari keadaan current → batas posisi/margin
  mengikat. Exit tetap TP/SL/likuidasi/manual milik Paper Exchange.
- `trade_records` (DERIVED) + MAE/MFE inkremental, R multiple, net PnL eksplisit
  (`gross − fees − funding`).
- Metrik `evaluation-v1`: win rate, PF (null tanpa kerugian), expectancy,
  drawdown realisasi, average R, distribusi exit, MAE/MFE.
- Replay otonom dua run → hash ekonomi, trade record, dan metrik identik.
- Golden: 1 trade LONG TP, size 72, entry 86498.7731, SL 85123, TP 89250.3,
  net +26.28533951, R 2.6536; 4 sinyal ditolak karena posisi terbuka.
- Keterbatasan: partial close otonom belum didukung; observasi funding belum
  dipersist.
- Alat `bun run evaluate:baseline -- <session> [--account <id>] [--execution on|off]`.

## Phase 11.5 — Ukuran kontrak desimal (SELESAI)

- Validasi ukuran dipisah: sintaktis (skema/DTO) vs kontrak (`assertValidSize`).
  `OrderIntentSchema.size` menerima desimal positif; kontrak integer tetap
  menolak pecahan sebagai order `rejected` ber-audit.
- DTO API menerima string desimal (`"1.25"`); ukuran numerik JSON ditolak.
- Aritmetika ukuran (matching, increase/reduce/close/flip, reservation) memakai
  `Decimal` dengan satu titik konversi (`toContractCount`) — bebas drift float.
- Fingerprint perintah memakai bentuk kanonik (`"1.5"` = `"1.50"` = `"1.500"`).
- `SIZE_NOT_EXECUTABLE` kini hanya untuk ukuran tidak sah (nol/negatif/non-hingga).
- Golden BTC Phase 11 TIDAK berubah (`experimentHash c57b9ce21a93312d`).
- Rekaman ETH sintetis: 1 entry terisi dengan ukuran pecahan `583.61239732`
  (sebelumnya 40× `SIZE_NOT_EXECUTABLE`); sisa sinyal ditolak
  `EXISTING_CONTRACT_POSITION` karena keadaan akun berkembang.

## Phase 12 — Jev Treatment + A/B Harness (SELESAI)

- Jev = PERLAKUAN: hanya probabilitas (trend/momentum/reversal/BTC regime),
  tanpa menentukan arah, ukuran, leverage, SL/TP, atau eksekusi.
- Kebijakan veto deterministik `jev-veto-v1`; ambang eksperimental, tidak
  dioptimasi. Ambang BTC hanya berlaku bila evaluator BTC diwajibkan.
- FAIL CLOSED: unavailable/invalid → kandidat tidak ditradingkan; tanpa fallback
  diam-diam ke baseline.
- Input kanonik + `jevInputHash`; tanpa akun/privat; tanpa informasi masa depan.
- Cache per (inputHash, evaluator, versi evaluator/prompt/skema, provider, model).
  `evaluate` sinkron (cache), `collect` terpisah (jaringan).
- Adapter fake deterministik (CI) + adapter nyata (env, timeout, tanpa rahasia).
- Persistensi `jev_evaluations` + `treatment_results` (migrasi 0011).
- Harness `bun run evaluate:ab -- <session>`: dua arm DB terisolasi, metrik
  berdampingan, analisis matched-trade deskriptif (vetoed winners/losers).
- Live di balik `CRYPASTRA_JEV=1` (default OFF), mode observasi cache;
  `bun run smoke:jev` opt-in (skip jujur tanpa kredensial).
- Kontrol beku: hash ekonomi Phase 11 tidak berubah.

## Phase 13 — Dataset Riset + Koleksi Jev + Label Hasil (SELESAI)

- Perekam pasar publik `bun run record:market` (universe kecil, tanpa API key),
  statistik periodik, SIGINT/SIGTERM, resumability eksplisit (universe sama →
  lanjut; berbeda → sesi lama `aborted`).
- Funding dipersist dari aliran publik (rate, timestamp, interval, mark) —
  celah persistensi Phase 8 tertutup.
- `LiveJevCollector`: antrean terbatas (kapasitas mencakup in-flight), konkurensi,
  rate limit, timeout, retry terbatas; antrean penuh → buang + catat. Ingest
  pasar/risiko/TP-SL tidak pernah menunggu Jev.
- Retry tidak pernah menggandakan evaluasi (identitas cache otoritatif);
  invalid tidak diulang; auth = fatal.
- Kelengkapan kandidat eksplisit; 3/4 evaluator bukan `complete`.
- `bun run jev:backfill` aman diulang (hanya yang hilang).
- `outcome-label-v1` OFFLINE: horizon [1,3,6,12], sumber OHLC candle, target
  tren (≥0.25%), momentum (return>0 dan MAE ≤1×ATR), reversal (MAE ≥1.5×ATR).
  Label `incomplete` bila masa depan kurang.
- Tabel `candidate_outcome_labels` (migrasi 0012) terpisah total dari
  `jev_evaluations`; guard kebocoran diuji.
- `bun run dataset:status` (kesiapan EMA200 + kualitas + bucket probabilitas
  deskriptif) dan `bun run dataset:export` (JSONL kanonik, hash deterministik,
  tanpa akun/rahasia).
- `bun run smoke:jev` memverifikasi adapter nyata; skip jujur tanpa kredensial.

## Belum dikerjakan (sesuai instruksi)

- Analisis statistik/kalibrasi lintas rekaman. Optimasi ambang. Eksekusi
  exchange nyata. (Phase 14+)
- Ukuran desimal pada OrderIntent; partial close; persistensi observasi funding.
- Replay UI/timeline controls; replay worker terpisah; seek per sekuens.
- Auth/otorisasi per akun (belum ada; batas tersendiri).
- Observasi funding belum dipersist, sehingga replay funding belum mungkin.

## Keputusan yang menunggu

- A1–A15 di `docs/PLAN.md` §10. Paling berdampak: A3 (dasar funding), A6 (formula
  likuidasi vs Gate.io), A9 (rate limit REST).
- File visual reference untuk UI belum ada di repo.
