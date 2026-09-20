# crypastra — Rencana Implementasi

Fase, kriteria penerimaan, edge case finansial, dan assumption yang harus diverifikasi.
Arsitektur: `docs/ARCHITECTURE.md`. Akuntansi: `docs/ACCOUNTING.md`.
Fakta Gate.io: `docs/gateio-market-data.md`.

## Prinsip pengerjaan

- Satu fase = satu PR. Tidak ada implementasi UI atau Jev sampai fase yang
  menyebutkannya.
- Setiap fase yang menyentuh uang **wajib** lulus `bun test` + `bun run check` dan
  menyertakan bukti before/after (output perintah, bukan klaim).
- Core (`@crypastra/core`) harus bisa diuji tanpa DB, tanpa network, tanpa jam nyata.
- Golden fixtures: skenario rekonsiliasi (`docs/fixtures/`) dijalankan di setiap fase.

---

## Phase 0 — Fondasi & verifikasi (fase ini)

**Tujuan:** buktikan arsitektur bisa berdiri, bukan bangun aplikasi.

Deliverable:
- Dokumen: `ARCHITECTURE.md`, `DATA-MODEL.md`, `ACCOUNTING.md`, `PLAN.md`,
  `PRODUCT.md`, `gateio-market-data.md`.
- ADR `docs/decisions/0001`–`0004`.
- Scaffolding: root `package.json` (Bun workspaces), `tsconfig.base.json`,
  `packages/core` (money, decimal konfigurasi, tipe domain, skema zod),
  `packages/adapters` (`MarketDataProvider` + `GateioMarketDataProvider` nyata),
  `tools/probe-gateio.ts`.
- Test: `bun test` untuk money & konversi kontrak; smoke provider live.

Kriteria penerimaan:
1. `bun install` sukses tanpa peer error.
2. `bun run check` (tsc --noEmit semua paket) hijau.
3. `bun test` hijau, termasuk test bahwa uang **tidak** memakai float (property test:
   `0.1 + 0.2` versi Decimal = `0.3`).
4. `bun run tools/probe-gateio.ts` menghubungi REST + WS Gate.io nyata dan mencetak
   contract spec + ≥1 candle 5m + ≥1 mark price. Ini bukti provider tidak hanya
   kompilasi.
5. `GateioMarketDataProvider` mengimplementasi interface yang sama dengan provider
   dummy, dan test membuktikan engine bisa menerima keduanya tanpa perubahan.

Non-goal fase ini: DB, HTTP API, web, matching engine penuh, Jev.

---

## Phase 1 — Skema & persistensi (SELESAI)

**Tujuan:** DB hidup, migrasi jalan, repository layer dengan konversi Decimal.

Deliverable:
- `apps/server/src/db/schema.ts` sesuai `DATA-MODEL.md` — 15 tabel.
- `drizzle.config.ts` + migrasi `0000` (skema) dan `0001` (trigger append-only).
- Repository: `contracts`, `candles`, `market_events`, `accounts`, `ledger`
  (+ `integrityReport`).
- `rebuildBalances()` + CLI `bun run db:migrate` yang melaporkan integritas saat boot.

Kriteria penerimaan:
1. ✅ `bun run db:generate` + migrate menghasilkan DB dari nol, idempoten saat
   dijalankan dua kali (dibuktikan pada DB kosong; 2 migrasi diterapkan).
2. ✅ Test: tidak ada kolom finansial bertipe `real`/`numeric` (tes memindai semua
   tabel via `PRAGMA table_info`).
3. ✅ Test round-trip desimal eksak, termasuk `0.00000001`, `80445.79000000`,
   `123456789.12345678`, `-0.0001`, dan nilai 20 dp → 8 dp.
4. ✅ Test: `ledger` menolak `UPDATE`/`DELETE` (trigger database, bukan guard kode).
5. ✅ Test: `rebuildBalances` == hasil turunan ledger, termasuk mendeteksi dan
   memperbaiki cache yang sengaja dirusak.

Penyimpangan dari rencana awal (didokumentasikan di ADR 0005):
- `GET /api/health/integrity` **belum** dibuat karena HTTP baru ada di Phase 5.
  Digantikan `integrityReport()` + pelaporan di CLI `db:migrate`.
- `margin_delta`/`reserved_delta` dipindah dari `meta_json` ke kolom eksplisit.
- `fills.order_id` dibuat nullable (fill likuidasi tidak punya order).

---

## Phase 2 — Paper exchange inti (math murni, tanpa DB/HTTP) — SELESAI

**Tujuan:** seluruh matematika uang di `packages/core` sebagai fungsi murni.

Deliverable (di `packages/core/src/`):
- `exchange/contract-math.ts` — satuan eksplisit: contracts ↔ qty ↔ notional,
  eksposur bertanda, validasi ukuran (termasuk `enable_decimal`), leverage, tick.
- `exchange/rounding.ts` — kebijakan pembulatan terpusat (satu-satunya tempat
  `toDecimalPlaces`/`Decimal.ROUND_*` boleh dipakai di `exchange/`).
- `exchange/fee.ts` — fee (taker/maker/rebate/nol) + funding.
- `exchange/pnl.ts` — unrealized/realized PnL linear.
- `exchange/margin.ts` — initial/maintenance margin, equity, available, rasio.
- `exchange/liquidation.ts` — `LiquidationModel` + `SimpleIsolatedLiquidationModel`.
- `exchange/tpsl.ts` — `triggerReached()` eksplisit + `evaluateTpSl()`.
- `exchange/matching.ts` — predikat murni + `planLevelConsumption` + `simulateFill`.
- `errors.ts` — error domain bertipe.
- `contract.ts` — skema + `enableDecimal` (koreksi Phase 0, lihat ADR 0006).

Kriteria penerimaan:
1. ✅ Fixture BTC_USDT menghasilkan angka persis (notional 8, margin 0.8,
   maintenance 0.024, taker fee 0.006, maker rebate −0.0008).
   Ditambah 7 fixture kontrak NYATA (BTC/ETH/SOL/XRP/PEPE/SATS/ARIA) dengan
   multiplier 0.0001–10000000 dan tick sampai 11 dp.
2. ✅ Semua murni: tanpa I/O, tanpa `Date.now()`, tanpa `Math.random()`.
3. ✅ Pembulatan terpusat & teruji; semantik fee dinyatakan lewat efek ekonomi
   (`ROUND_CEIL` pada amount bertanda), bukan nama mode Decimal.
4. ✅ Maker rebate tetap negatif dan tidak di-clamp.
5. ✅ 15 skenario likuidasi + batas (leverage 1, leverage maks, harga ekstrem,
   MMR tinggi, keadaan degenerate) hijau.
6. ✅ Uji properti deterministik (sweep rentang, tanpa randomness) untuk seluruh
   kontrak nyata: `liq_long < entry < liq_short` pada setiap leverage sah.
   `fast-check` tidak ditambahkan — sweep deterministik lebih kuat dan tidak
   menambah dependensi.

Ditemukan & diperbaiki (detail di ADR 0006):
- `enable_decimal` hilang dari `ContractSpec` (14/997 kontrak, termasuk ETH/SOL);
  `order_size_min = 0` meloloskan ukuran 0.
- `avgPrice` matching Phase 0 salah faktor `quanto_multiplier`.
- Klaim "gap" pada prioritas SL di `ACCOUNTING.md` §7 keliru.
- Clamp `liq price <= 0` dihapus; keadaan degenerate dikembalikan bertipe.

---

## Phase 3 — Order & matching + margin reservation — SELESAI

**Tujuan:** order hidup dari `created` sampai `filled`, dengan reservasi margin.

Deliverable:
- `OrderService`: validasi (tick, size min/max, leverage, saldo, reduce-only).
- `MatchingEngine`: market (IOC, slippage dari buku) dan limit (maker/taker, partial).
- `MarginEngine`: reservasi/pelepasan.
- `PositionEngine`: buka, tambah, kurangi, tutup, **flip** (tanpa size negatif).
- Tabel `orders`, `fills`, `positions`, `order_events`, `position_events` terisi
  atomik dalam satu transaksi SQLite per perintah.

Kriteria penerimaan (semua terpenuhi, kecuali yang dicatat):
1. ✅ Market order dieksekusi lawan snapshot buku, fee taker per fill.
2. ✅ Limit marketable → taker; limit resting → maker saat terisi dari snapshot
   berikutnya. post_only yang menyentuh buku ditolak.
3. ✅ Order yang melebihi `available_balance` ditolak dengan nol efek ekonomi
   (diperiksa lewat dry-run sebelum efek apa pun).
4. ✅ Partial fill + cancel melepas hanya sisa reservasi; invariant saldo dijaga.
5. ✅ Flip menghasilkan dua baris posisi (close + open), tidak ada size negatif.
6. ✅ Transisi status menulis `order_events`; mutasi posisi menulis `position_events`.
7. ✅ Skenario deterministik 1200 operasi memeriksa seluruh invariant yang dapat
   diperiksa di Phase 3 (lihat `tests/phase3-scenario-1000.test.ts`).

Tambahan yang diimplementasikan: tabel `trade_commands` untuk idempotensi per
perintah (ADR 0007), repository order/fill/posisi/event, `OrderService`
(submit/evaluate/cancel) dengan transaksi tunggal `BEGIN IMMEDIATE`, dan test
injeksi kegagalan (rollback setelah order insert, reservasi, fill, dan ledger PnL).

Bug nyata yang ditemukan & diperbaiki: `statusAfterExecution` membatalkan order
resting yang tidak tersentuh snapshot, sehingga reservasinya tertahan dan cache
akun menyimpang dari Σ reservasi order. Lihat ADR 0007.

---

## Phase 4 — Mark-to-market, funding, likuidasi, TP/SL — SELESAI

**Tujuan:** posisi hidup seiring waktu, diproses deterministik dari snapshot
mark price eksplisit. Tidak ada loop/scheduler/WebSocket (sesuai lingkup).

Deliverable:
- Core murni: `exchange/valuation.ts` (MarkSnapshot, staleness, valuasi posisi &
  akun), `exchange/funding-policy.ts` (kebijakan & kunci funding),
  `exchange/settlement.ts` (`settleIsolatedClose`, `executionPriceFor`).
- `apps/server/.../mark-to-market-service.ts`: `processMark`, `closePosition`,
  `evaluateAccount`, `cashValuation`.
- TP/SL dipropagasikan dari `OrderIntent` ke `positions.tp_price`/`sl_price`.

Kriteria penerimaan:
1. ✅ Funding diterapkan tepat sekali per `(contract, fundingTimestampMs, position)`
   walau tick dipanggil berulang, lintas commandId, dan setelah restart service.
2. ✅ Funding long rate>0 mengurangi `wallet_balance`; short menambah. Rebate
   negatif tidak di-clamp.
3. ✅ Posisi terlikuidasi saat `equity ≤ maintenance`; kas tidak pernah negatif;
   defisit yang melebihi kolateral isolated dicatat sebagai `liquidation_loss`
   + `insolvent` (bukan dihapus).
4. ✅ SL menang atas TP bila keduanya terpicu; likuidasi menang atas keduanya.
5. ✅ `mark_price` menggerakkan valuasi/likuidasi/funding/TP-SL; harga EKSEKUSI
   berasal dari `ExecutionQuote` eksplisit (gap tidak dipalsukan).
6. ✅ Mark-to-market tidak menulis ledger sama sekali.

Tambahan di luar rencana awal (didokumentasikan di ADR 0008): staleness gate
sebagai langkah pertama presedensi, kebijakan urutan funding vs aksi risiko,
`ExecutionQuote` (bid/ask) untuk harga eksekusi, dan semantik defisit insolvensi.

Tidak ada migration baru: kolom TP/SL, `close_reason`, dan flag
`is_liquidation`/`is_tp_sl` sudah ada sejak Phase 1.

---

## Phase 5 — API + realtime — SELESAI

**Tujuan:** backend bisa dipakai UI.

Deliverable (`apps/server`, Fastify):
- REST: `/api/contracts`, `/api/market/candles`, `/api/market/ticker`,
  `/api/account`, `/api/account/ledger`, `/api/orders` (POST/GET/DELETE),
  `/api/positions`, `/api/history`, `/api/wallet/deposit|withdraw|reset`,
  `/api/mode` (live/simulation/replay), `/api/health/integrity`.
- WS `/ws`: stream `market.*`, `order.*`, `position.*`, `account.*`, `ledger.*`
  dengan `afterSeq` (pola piastra `realtime/websocket.ts` + `events/event-bus.ts`).
- Throttle: `book_ticker`/`order_book_update` diagregasi sebelum dikirim (≥250 ms).

Kriteria penerimaan (terpenuhi):
1. ✅ Semua endpoint memakai skema zod; field asing ditolak pada operasi tulis.
2. ✅ WS `afterSeq` tidak menggandakan/menghilangkan event; celah snapshot→subscribe
   diuji eksplisit.
3. ✅ Order invalid ditolak dengan alasan spesifik; order yang ditolak tidak
   menyentuh ledger sama sekali.
4. ✅ Deposit/withdraw/reset tercatat di ledger sebagai entri bertanda; reset
   MENOLAK bila masih ada posisi/order terbuka (ledger tidak pernah ditulis ulang).
5. ✅ Ringkasan API konsisten dengan ledger (integritas 200/503 + test rekonsiliasi).

Tambahan di luar rencana awal (ADR 0009): outbox `domain_events` dengan urutan
global, kolom `trade_commands.request_hash` untuk deteksi konflik payload,
`MarketSnapshotProvider`, endpoint simulasi, OpenAPI ringkas, backpressure nyata,
dan pengurutan stabil berbasis `rowid`.

---

## Phase 6 — Live Gate.io market data runtime — SELESAI

**Tujuan:** feed pasar publik Gate menggerakkan paper exchange secara live.

Deliverable:
- Core murni: `exchange/depth-book.ts` (sinkronisasi L2), `exchange/market-state.ts`.
- Adapters: reconnect dengan backoff (timer dapat disuntik), resubscribe dari
  state keinginan, status koneksi, metrik, channel `futures.book_ticker`.
- Server: `LiveMarketSnapshotProvider`, `MarketRuntime`, `LiveRiskProcessor`,
  mode `simulation|live`, `/api/v1/market/health`, stream pasar ephemeral di `/ws`.
- Tools opt-in: `bun run smoke:live`, `bun run smoke:paper`.

Kriteria penerimaan (terpenuhi):
1. ✅ Server tersambung ke WS publik Gate; mark/last/index terpisah dan tidak
   saling menggantikan.
2. ✅ Best bid/ask tersedia dari `futures.book_ticker`; tidak ada kutipan palsu
   bila salah satu sisi hilang.
3. ✅ Buku kedalaman lokal untuk kontrak terpilih, dengan gap → UNSYNCED dan
   eksekusi diblokir sampai resync REST berhasil.
4. ✅ Candle 5m diproses; hanya candle TERTUTUP yang dipersist.
5. ✅ Mark segar menggerakkan valuasi/risiko lewat `MarkToMarketService`.
6. ✅ Kontrak Phase 5 tidak berubah; provider live memenuhi interface yang sama.
7. ✅ Peristiwa pasar tidak pernah masuk `domain_events` (diuji).

Tambahan di luar rencana awal (ADR 0010): event ternormalisasi `book_ticker`,
kebijakan persistensi eksplisit, id perintah runtime deterministik, dan perbaikan
`request_hash` pada submit order (follow-up Phase 5).

## Phase 7A — Terminal paper trading (baca/observasi) — SELESAI

**Tujuan:** terminal browser yang dapat dipakai melihat paper exchange live.

Deliverable:
- `apps/web`: Svelte 5 + Vite + Tailwind 4 + lightweight-charts, token desain
  di `app.css`, dokumen `docs/design/DESIGN_SYSTEM.md` + `docs/design/TERMINAL.md`.
- Lapisan data klien: `lib/api/*` (client + accounts/contracts/positions/orders/
  history/market), `lib/realtime/*` (domain + market stream), `lib/stores`.
- Read model backend tambahan: `GET /api/v1/market/state`, `GET /api/v1/market/candles`.
- Panel: TopBar (badge PAPER), Watchlist, MarketHeader, Chart, AccountPanel,
  TradePanelPreview, BottomWorkspace (Positions/Orders/Fills/History/Ledger).
- Aksi akun: buat/deposit/withdraw/reset dengan `commandId` yang dipakai ulang
  saat retry.

Kriteria penerimaan (terpenuhi):
1. ✅ Identitas PAPER persisten di header + label "VIRTUAL FUNDS" di panel akun.
2. ✅ Mark/last/index dibedakan; mark diberi penjelasan tooltip.
3. ✅ Status feed diturunkan dari kesehatan pasar server, bukan status WebSocket
   browser; mark basi ditandai.
4. ✅ Chart 5m dari backend (browser tidak menyentuh Gate), instance persisten.
5. ✅ Realtime: dedupe `seq`, resume `afterSeq`, `resync_required` → snapshot baru.
6. ✅ Nilai finansial tetap string; kolom memakai desimal tetap; `—` bila absen.
7. ✅ Chart watchlist hanya melanggan kontrak yang terlihat.
8. ✅ Setiap panel punya keadaan loading/empty/error/stale.

## Phase 7B — Trade entry & position management UX — SELESAI

**Tujuan:** terminal 7A menjadi terminal yang dapat dipakai trading (PAPER).

Deliverable:
- `apps/web/src/lib/trade/`: `decimal.ts` (aritmetika desimal), `preview.ts`
  (mesin preview murni), `ticket.ts` (state machine pengiriman), `intent.ts`.
- Komponen: `OrderTicket.svelte`, `ProtectionForm.svelte`, `ClosePositionForm.svelte`,
  plus aksi Cancel/Close/TP-SL di tabel Orders & Positions.
- Lapisan API tulis: `orders.submit/cancel`, `positions.close/amendProtection`.

Kriteria penerimaan (terpenuhi):
1. ✅ Tiket LONG/SHORT + MARKET/LIMIT + size + leverage + TP/SL, dengan identitas
   PAPER/VIRTUAL FUNDS yang mencolok dan tanpa teks menyesatkan.
2. ✅ Input finansial tetap string mentah; tidak ada `Number` di jalur tiket/preview.
3. ✅ Validasi dari ContractSpec (enable_decimal, size min/max, tick 11 dp,
   leverage, fee, multiplier) — diuji lintas kontrak heterogen.
4. ✅ Preview market memakai ASK (LONG) / BID (SHORT); limit marketable
   (inklusif) vs resting; estimasi margin/fee/reservasi berlabel "Est.".
5. ✅ Status pengiriman eksplisit termasuk `outcome_uncertain`; payload dibekukan
   dan retry memakai commandId + payload sama.
6. ✅ Cancel/Close/Edit Protection dengan commandId sendiri, pending state, dan
   rekonsiliasi lewat peristiwa domain + refresh.

Tidak ada perubahan arsitektur backend: seluruh endpoint yang dibutuhkan sudah ada
sejak Phase 5/6.


## Phase 8 — Deterministic market recording & replay — SELESAI

**Tujuan:** jendela pasar terekam menggerakkan mesin ekonomi yang sama.

Deliverable: `exchange/observations.ts` + `exchange/canonical.ts` (core),
migrasi 0006/0007, `MarketObservationRepository`/`RecordingSessionRepository`,
`MarketRecorder`, `ReplayMarketDataProvider`, `ReplayService`,
`smoke:record-replay`.

Kriteria penerimaan (terpenuhi):
1. ✅ Replay masuk lewat `MarketDataProvider`; satu mesin ekonomi (tanpa engine kedua).
2. ✅ Observasi cukup untuk mark, quote, funding, candle (bukan hanya candle).
3. ✅ Urutan kanonik `seq`; VirtualClock dari `observedAtMs`; STEP == MAX.
4. ✅ Isolasi dua koneksi; akun LIVE tidak tersentuh.
5. ✅ Hasil replay dengan sidik jari kanonik; dua putaran identik.
6. ✅ Rekaman OFF = perilaku Phase 6 tidak berubah.
7. ✅ Live capture → replay terbukti deterministik (554 observasi, hash identik).

## Phase 9 — Deterministic Feature Engine & Market Scanner — SELESAI

**Tujuan:** lapisan intelijen pasar deterministik di antara data pasar dan
Decision Engine/Jev yang akan datang: "apa yang sedang terjadi di pasar ini?" —
bukan "berapa uang yang harus ditradingkan".

Deliverable: `packages/core/src/analytics/{features,scanner,research}.ts`,
`AnalyticsService`, `FeatureSnapshotRepository`/`ScannerResultRepository`,
migrasi 0008, `tools/analyze-recording.ts`, `docs/FEATURES.md`, `docs/SCANNER.md`,
ADR 0012.

Kriteria penerimaan (terpenuhi):
1. ✅ Candle tertutup 5m → FeatureSnapshot → Scanner → Candidate/Signal.
2. ✅ Inti murni; guard impor + test kunci hasil membuktikan tanpa DB/order/ledger/leverage.
3. ✅ Hanya candle tertutup; tidak ada sinyal intrabar.
4. ✅ Definisi eksak EMA/RSI/MACD/ATR/return/volume + presisi desimal analitik.
5. ✅ Warmup eksplisit (`warmupComplete`, `warmupRemaining`); scanner skip saat belum siap.
6. ✅ Engine inkremental; hasil identik dengan orakel batch.
7. ✅ Duplikat tidak maju; out-of-order ditolak tanpa merusak keadaan.
8. ✅ Persistensi idempoten + `featureVersion`/`scannerVersion`/`scannerConfigHash`.
9. ✅ Scanner config-driven; kandidat ≠ sinyal; reasonCodes mesin-baca.
10. ✅ Konteks BTC tersedia tapi tidak memveto kecuali diminta.
11. ✅ Isolasi antar kontrak.
12. ✅ Satu jalur untuk live dan replay (tanpa engine kedua).
13. ✅ Dua run riset menghasilkan hash kanonik identik; fixture golden 280 candle.
14. ✅ Analitik tidak mengubah hash ekonomi apa pun; kegagalan tidak menjatuhkan ingest.
15. ✅ Tanpa eksekusi order, sizing, leverage, TP/SL, optimasi, atau Jev.

## Phase 10 — Deterministic Decision & Risk Engine — SELESAI

**Tujuan:** lapisan deterministik yang mengubah FeatureSnapshot + ScannerResult +
keadaan akun + kebijakan risiko menjadi Decision, dan bila disetujui menjadi
TradePlan — TANPA mengeksekusi order.

Deliverable: `packages/core/src/decision/{types,risk-policy,tick-policy,engine,hashing}.ts`,
`DecisionService`/`DecisionCoordinator`, `DecisionRepository`, migrasi 0009,
`tools/analyze-decisions.ts`, `docs/DECISIONS.md`, `docs/RISK.md`, ADR 0013.

Kriteria penerimaan (terpenuhi):
1. ✅ Decision Engine & Risk Engine murni; guard impor membuktikan tanpa DB/order/ledger/waktu/acak.
2. ✅ Scanner tetap tidak melihat wallet/posisi/margin/leverage; Risk Engine tidak menghitung ulang indikator.
3. ✅ Sizing dari anggaran risiko (`equity × riskPerTradePct`), bukan `wallet × leverage`.
4. ✅ Stop dari ATR; jarak stop minimum/maksimum ditegakkan dengan reason code.
5. ✅ Pembulatan tick arah-sadar (SL menjauh dari risiko, TP menjauh dari harapan); diuji sampai 11 dp.
6. ✅ Ukuran dinormalisasi (integer floor / desimal floor); cap notional & cap kontrak menurunkan ukuran saja.
7. ✅ Leverage deterministik dijepit batas kebijakan + kontrak; tidak dari keyakinan sinyal.
8. ✅ Batas margin (saldo tersedia + total margin) dan batas posisi ditegakkan.
9. ✅ SKIP dipersist; keputusan idempoten per (akun, kontrak, candle, versi, hash).
10. ✅ `decisionVersion`/`riskPolicyVersion`/hash semua versi dipersist.
11. ✅ Bukti tanpa eksekusi: 100 evaluasi tidak mengubah tabel ekonomi apa pun.
12. ✅ Live observasional di balik `CRYPASTRA_DECISIONS` (default OFF).
13. ✅ Replay memakai engine yang sama; dua run menghasilkan keputusan identik.
14. ✅ Fixture golden LONG/SHORT dengan angka eksak + hash beku.
15. ✅ Tanpa eksekusi order, optimasi, Jev, atau panggilan LLM.

## Phase 11 — Autonomous PAPER Execution & Baseline Evaluation — SELESAI

**Tujuan:** menghubungkan TradePlan deterministik yang disetujui ke mesin
eksekusi PAPER yang SUDAH ADA, lalu mengukur baseline sebagai kelompok kontrol.

Deliverable: `packages/core/src/evaluation/{trade-record,metrics,experiment}.ts`,
`TradeExecutionService`, `AutonomousTradeTracker`,
`DecisionExecutionRepository`, `TradeRecordRepository`, migrasi 0010,
`tools/evaluate-baseline.ts`, `docs/EXECUTION.md`, `docs/EVALUATION.md`, ADR 0014.

Kriteria penerimaan (terpenuhi):
1. ✅ Gate eksekusi eksplisit (`CRYPASTRA_EXECUTION=1`), default OFF, inert.
2. ✅ PAPER only: hanya OrderService yang ada; tanpa endpoint/kredensial Gate.
3. ✅ Lapisan tipis: memetakan TradePlan → OrderIntent tanpa perhitungan ulang.
4. ✅ Idempotensi deterministik (`auto-entry:<decisionId>`) memakai arsitektur OrderService.
5. ✅ Linkage `decision_executions` unik per keputusan.
6. ✅ Status eksekusi eksplisit; penolakan ekonomi ≠ kegagalan sistem.
7. ✅ SKIP tidak dapat dieksekusi (10.000 evaluasi → nol order).
8. ✅ Keadaan akun berkembang: batas posisi & margin benar-benar mengikat.
9. ✅ Exit tetap milik Paper Exchange (tanpa mesin exit kedua).
10. ✅ Quote drift & drift risiko diukur, bukan disembunyikan.
11. ✅ TradeRecord derived + MAE/MFE inkremental + R multiple + net PnL eksplisit.
12. ✅ Metrik agregat deskriptif (PF null tanpa kerugian, drawdown realisasi).
13. ✅ Identitas eksperimen ter-hash + versi lengkap.
14. ✅ Replay otonom memakai jalur yang sama; dua run identik (hash + metrik).
15. ✅ A/B eksekusi OFF/ON eksplisit; skenario tanpa trade valid.
16. ✅ Live otonom PAPER opt-in dengan logging jelas.
17. ✅ Tanpa Jev, LLM, optimasi, atau eksekusi exchange nyata.

## Phase 11.5 — Decimal Contract Size Execution Compatibility — SELESAI

**Tujuan:** menghapus batas buatan yang membuat `TradePlan` berukuran desimal
(kontrak `enable_decimal=true`) mustahil dieksekusi, tanpa melemahkan kontrak
integer dan tanpa mengubah `risk-v1`/`scanner-v1`/rumus evaluasi.

Deliverable: relaksasi `OrderIntentSchema.size`, validasi sadar kontrak di
`assertValidSize`/repositori, aritmetika ukuran berbasis `Decimal`
(`planLevelConsumption`, `planPositionTransition`), kanonikalisasi fingerprint,
DTO API string desimal, ADR 0015, `docs/EXECUTION.md`/`docs/API.md`/`docs/ACCOUNTING.md`.

Kriteria penerimaan (terpenuhi):
1. ✅ `size` desimal pada kontrak `enable_decimal=true` dapat dieksekusi penuh
   (TradePlan → OrderIntent → OrderService → matching → fills → positions → ledger).
2. ✅ Kontrak integer tetap menolak pecahan (order `rejected` ber-audit).
3. ✅ `SIZE_NOT_EXECUTABLE` hanya untuk ukuran tidak sah.
4. ✅ Tidak ada drift float pada aritmetika ukuran.
5. ✅ Idempotensi tidak pecah karena format (`1.5` = `1.50`).
6. ✅ DTO API tetap string; ukuran numerik JSON ditolak.
7. ✅ Frontend sudah benar sejak Phase 7B (`enableDecimal` → step/integer).
8. ✅ Golden BTC Phase 11 tidak berubah (hash sama).
9. ✅ Replay otonom memakai OrderService yang sama (tanpa jalur khusus).
10. ✅ Tanpa perubahan `risk-v1`, `scanner-v1`, rumus evaluasi, atau Jev.

## Phase 12 — Jev Probabilistic Treatment + A/B Harness — SELESAI

**Tujuan:** menambahkan Jev sebagai PERLAKUAN eksperimental (probabilitas +
veto deterministik) tanpa mengubah kontrol apa pun, plus harness A/B reproducible.

Deliverable: `packages/core/src/treatment/{types,input-hash,output-schema,policy,port,treatment}.ts`,
`packages/adapters/src/jev/{fake,real}-jev-adapter.ts`, migrasi 0011,
`JevEvaluationRepository`/`TreatmentResultRepository`, integrasi coordinator +
replay, `tools/evaluate-ab.ts`, `tools/smoke-jev.ts`, `docs/JEV.md`,
`docs/EXPERIMENTS.md`, ADR 0016.

Kriteria penerimaan (terpenuhi):
1. ✅ Kontrol beku: tanpa perlakuan, hash ekonomi Phase 11 tidak berubah.
2. ✅ Abstraksi `CandidateTreatment` (`NoTreatment` / `JevTreatment`); tanpa `if (jev)` tersebar.
3. ✅ Jev pra-risiko, hanya untuk kandidat scanner.
4. ✅ Empat evaluator terpisah; probabilitas bermakna sendiri; tanpa "AI confidence" generik.
5. ✅ Validasi output eksternal ketat; probabilitas ∈ [0,1].
6. ✅ Input kanonik + `jevInputHash`; tanpa akun/privat; tanpa informasi masa depan.
7. ✅ Adapter fake deterministik + adapter nyata (env, timeout, tanpa rahasia di hash/log).
8. ✅ Cache berbasis identitas; versi prompt/evaluator/model memisahkan identitas.
9. ✅ `jev-veto-v1` deterministik; default eksperimental; ambang BTC hanya bila diwajibkan.
10. ✅ FAIL CLOSED pada unavailable/invalid.
11. ✅ Persistensi `jev_evaluations` + `treatment_results`; tanpa rahasia.
12. ✅ Jev tidak dapat mengubah ukuran/leverage/SL/TP (guard impor + test).
13. ✅ Harness A/B dengan DB terisolasi per arm + analisis matched-trade deskriptif.
14. ✅ Determinisme dua run dengan evaluasi tercache.
15. ✅ Live di balik `CRYPASTRA_JEV=1` (default OFF), mode cache; smoke opt-in.
16. ✅ Tanpa optimasi ambang, tanpa perubahan risk-v1/scanner-v1, tanpa trading nyata.

## Phase 13 — Real Market Dataset + Live Jev Collection + Outcome Labeling — SELESAI

**Tujuan:** mengubah arsitektur riset menjadi sistem yang dapat mengumpulkan data
nyata secara kontinu: rekaman pasar publik, koleksi Jev asinkron terbatas, label
hasil offline, pelaporan kualitas, dan ekspor reproducible.

Deliverable: `packages/core/src/labels/{outcome-label,dataset}.ts`,
`LiveJevCollector`, `OutcomeLabeler`, `DatasetBuilder`, migrasi 0012,
`CandidateOutcomeLabelRepository`, tool `record:market` / `dataset:status` /
`jev:backfill` / `dataset:label` / `dataset:export`, `docs/{DATASET,LABELS,COLLECTION}.md`, ADR 0017.

Kriteria penerimaan (terpenuhi):
1. ✅ Perekam pasar publik dengan UX sesi, statistik periodik, SIGINT/SIGTERM, resumability eksplisit.
2. ✅ Funding dipersist dari aliran publik (rate, timestamp, interval, mark) — celah Phase 8 tertutup.
3. ✅ Kolektor Jev asinkron terbatas; ingest/risiko/TP-SL tidak pernah menunggu.
4. ✅ Antrean penuh → buang + catat; konkurensi, rate limit, timeout, retry terbatas.
5. ✅ Retry tidak pernah menggandakan evaluasi (identitas cache otoritatif).
6. ✅ Kelengkapan kandidat eksplisit (`complete` hanya bila seluruh evaluator berhasil).
7. ✅ Backfill aman diulang; hanya mengambil yang hilang.
8. ✅ `outcome-label-v1` fixed: horizon [1,3,6,12], satu sumber harga, target tren/momentum/reversal.
9. ✅ Label `incomplete` bila masa depan kurang; tidak dipotong diam-diam.
10. ✅ Label terpisah total dari Jev; guard kebocoran diuji.
11. ✅ `dataset:status` (kesiapan EMA200 + kualitas + bucket probabilitas deskriptif).
12. ✅ `dataset:export` JSONL urutan kanonik; dua ekspor → hash identik.
13. ✅ Tanpa akun/wallet/rahasia di ekspor.
14. ✅ Kontrol & perlakuan Phase 12 tidak berubah; tanpa optimasi; tanpa trading nyata.
