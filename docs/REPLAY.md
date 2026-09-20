# Replay — Rekaman Deterministik & Pemutaran Ulang

Phase 8. Tujuan: jendela pasar yang direkam dapat menggerakkan **mesin ekonomi yang
SAMA** (`MarketRuntime` → `MarketState` → `MarketToMarketService`/`OrderService`)
tanpa konsumen tahu apakah sumbernya LIVE atau REPLAY.

Prinsip: **satu mesin ekonomi.** Tidak ada `ReplayExchange`, `ReplayPnLCalculator`,
`BacktestOrderService`, atau `ReplayLiquidationEngine`.

```
Gate publik ──► parser ──► observasi ternormalisasi ──► recorder ──► MARKET_OBSERVATIONS
                                        │
                                        └──────────────► MarketRuntime ──► MarketState
                                                                              │
MARKET_OBSERVATIONS ──► ReplayMarketDataProvider ──► MarketRuntime ───────────┤
                                                                              ▼
                                                                    Paper Exchange (sama)
```

## 1. Model observasi

Empat jenis, semua bernilai finansial **string**:

| kind | isi | kelas |
|---|---|---|
| `mark` | `markPrice`, `lastPrice?`, `indexPrice?` | **EKONOMI** |
| `quote` | `bestBid/BidSize`, `bestAsk/AskSize` | **EKONOMI** |
| `funding` | `fundingRate`, `fundingTimestampMs`, `intervalSeconds`, **`markPrice`** | **EKONOMI** |
| `candle` | `interval`, `openTimeSeconds`, `o/h/l/c`, `volume`, `closed` | **ANALITIK** |

Semua membawa `contract`, `sourceTimestampMs` (jam exchange) dan `observedAtMs`
(jam lokal saat diterima).

**Ekonomi vs analitik.** Harga close candle BUKAN pengganti mark maupun kutipan
yang dapat dieksekusi. Candle akan dipakai indikator/scanner/strategy; mark dan
quote yang menentukan perilaku paper exchange. Jangan mencampukannya.

**Kenapa `funding` membawa `markPrice`.** `MarkToMarketService` menghitung funding
dari notional pada MARK. Rekaman harus mandiri: bukan merekonstruksi funding dari
API hari ini, dan bukan memakai mark terakhir yang kebetulan ada. `markPrice` juga
disimpan pada `mark` dan `funding` karena `observedAtMs` dan `sourceTimestampMs`
sengaja dipisah: waktu exchange antar kanal dapat saling mendahului, sedangkan
waktu lokal mengikuti urutan penerimaan (tidak pernah mundur). Staleness
dihitung `observedAtMs − sourceTimestampMs`.

## 2. Penyimpanan

```
market_recording_sessions(id, source, contracts_json, status, started_at, ended_at, metadata_json)
market_observations(seq PK AUTOINCREMENT, session_id FK, contract, kind,
                    source_timestamp_ms, observed_at_ms, dedupe_key UNIQUE,
                    data_json, created_at)
```

- `seq` = **urutan total kanonik** replay (`ORDER BY seq ASC`), bukan timestamp.
- Append-only: trigger menolak `UPDATE`/`DELETE`.
- Indeks untuk filter sesi/kontrak/jenis dan paginasi `seq`.
- `dedupe_key` = `{session}:{contract}:{kind}:{sourceTimestampMs}[:{openTime}]`
  (identitas SUMBER, bukan nilai).

## 3. Sesi perekaman

`RecordingSessionRepository`: `start` / `stop` / `require` / `active` / `list`.
Sesi memberi identitas eksplisit ("putar rekaman X") alih-alih menebak rentang
waktu dari tabel yang tidak berhubungan.

## 4. Penempatan perekam

`MarketRecorder` dipasang di **batas ternormalisasi**, bukan pada paket mentah:
`observationsFromEvent(event, nowMs)` mengubah event yang SAMA dengan yang
dikonsumsi runtime menjadi observasi. Jalur live dan replay melewati pemetaan
`observationToEvents` yang sama, sehingga replay tidak pernah mem-parse ulang
payload Gate.

## 5. Kebijakan persistensi

| Saat perekaman MATI | Saat perekaman HIDUP |
|---|---|
| perilaku Phase 6 tidak berubah: hanya candle 5m tertutup yang disimpan | observasi ekonomi + candle tertutup direkam |

Volume (kebijakan terukur, `shouldRecordObservation`):

- `mark` — **selalu** ditulis. Frekuensi ticker rendah, dan menulis setiap tick
  menjaga staleness replay identik dengan live (mark yang nilainya sama tetap
  memperbarui waktunya).
- `quote` — hanya saat bid/ask/ukuran **berubah**.
- `funding` — hanya saat rate atau jadwal berubah.
- `candle` — hanya candle tertutup.
- **Depth tidak direkam** (eksekusi live memakai puncak buku, bukan kedalaman).

"Harga sama dua kali" pada waktu berbeda BUKAN duplikat.

## 6. VirtualClock

`virtualClock` (core) di-set ke **`observedAtMs`** observasi sebelum diproses,
karena live menghitung staleness sebagai `clock lokal − sourceTimestampMs` dan
`observedAtMs` persis nilai itu. Memakai `sourceTimestampMs` akan membuat
staleness selalu 0 dan menyembunyikan gap yang nyata.

VirtualClock tidak pernah mundur. Bila rekaman tak terurut, waktu di-clamp ke
nilai tertinggi sementara observasi tetap diproses **pada urutan `seq`** —
perilaku eksplisit untuk data tak terurut, bukan data yang dikarang.

## 7. ReplayMarketDataProvider

Mengimplementasikan `MarketDataProvider` yang sama. State: `idle | running |
paused | completed | failed`. Pacing: `step | max | 1x | 10x | 100x`.

**Kecepatan hanya mengubah waktu dinding.** VirtualClock, urutan event, funding,
TP/SL, likuidasi, fill, dan ledger identik antara `step` dan `max` (diuji).

## 8. Perintah terjadwal

```ts
{ afterObservationSeq, kind: "submit_order" | "amend_protection" | "close_position", ... }
```

Dijalankan lewat `OrderService`/`PositionService`/`MarkToMarketService` yang sama,
dengan id perintah deterministik `replay:{sessionId}:{index}` (tanpa UUID acak).
Order market memakai kutipan yang tersedia **pada titik itu**; bila kutipan belum
ada, perintah dilewati dengan alasan eksplisit (bukan dikarang).

## 9. Isolasi (dua koneksi)

```
source : database REKAMAN  — dibaca saja (observasi pasar)
target : database terisolasi — SEMUA tulisan ekonomi
```

Rekaman pasar bukan keadaan akun, jadi tidak perlu disalin; yang diisolasi adalah
ekonominya. Akun paper LIVE tidak pernah tersentuh dan tidak ada "rewind"
destruktif. Bila `source` tidak diberikan, ia sama dengan `target` (untuk test).

## 10. Hasil & hashing kanonik

`ReplayResult` memuat jumlah observasi/perintah, waktu virtual awal/akhir, saldo,
jumlah order/fill/posisi/ledger, hasil perintah, dan sidik jari.

`canonicalize` + `fingerprint` (FNV-1a 64-bit) menghasilkan `ledgerHash`,
`positionsHash`, `fillsHash`, `ordersHash`, `balancesHash`, `combinedHash`.

**Disertakan:** nilai ekonomi (tipe, amount, margin/reserved delta, balanceAfter,
refType, harga, ukuran, status).
**Dikecualikan:** `seq` ledger, `idempotencyKey` (mengandung UUID akun/fill),
UUID acak, rowid, waktu dinding. Baris diurutkan berdasarkan **isi**, bukan urutan
iterasi DB.

Ini sidik jari determinisme, bukan hash kriptografis. Klaimnya "ekuivalen secara
kanonik", bukan "database SQLite identik byte-per-byte".

## 11. Semantik yang dipertahankan apa adanya

| Peristiwa | Perilaku (simulator saat ini) |
|---|---|
| Order market | eksekusi di **ASK/BID** dari kutipan (bukan mark) |
| Penutupan MANUAL | kutipan buku (LONG → bid, SHORT → ask) |
| Penutupan OTOMATIS (TP/SL/likuidasi) | **mark saat pemicu** (kebijakan simulator Phase 6) |
| TP/SL | terpicu dari **mark**; bukan harga trigger |
| Likuidasi | model simulator yang sama; defisit dicatat eksplisit |
| Funding | basis mark, sekali per `fundingTimestampMs`, prioritas setelah aksi risiko |

Replay memutar semantik ini, tidak mengubahnya.

## 12. Kegagalan & data hilang

- Observasi rusak → `ValidationError` (bukan dilewati diam-diam).
- Kutipan tidak ada saat perintah butuh eksekusi → perintah **dilewati** dengan
  alasan, bukan memakai harga karangan.
- Mark tidak ada → observasi mark tidak dibuat, sehingga valuasi melaporkan
  kontrak tersebut sebagai tanpa nilai.
- Kontrak tidak dikenal di database target → gagal cepat.

## 13. Volume penyimpanan (terukur)

Dari rekaman live 25 detik (BTC_USDT, `SMOKE_TRADE=1`):

```
total observasi   554      (mark 21, quote 532, funding 1)
observasi/detik   22.5
payload           99 035 byte
proyeksi 1 jam    14.1 MiB
proyeksi 8 jam    110.5 MiB
proyeksi 24 jam   331.6 MiB
```

**Temuan:** `quote` mendominasi (~96% baris). Mark dan funding sangat murah. Untuk
mengumpulkan dataset 24 jam, kebijakan quote perlu ditinjau (mis. pergerakan tick
minimum, atau sampling periodik) sebelum volume menjadi masalah. Jangan optimasi
sekarang; ini catatan untuk sebelum pengumpulan dataset strategy.

## 14. Retensi

Belum ada penghapusan otomatis, dan tidak boleh ada yang diam-diam: observasi
append-only dan trigger menolak `DELETE`. Purge per sesi (bila nanti diperlukan)
harus berupa operasi eksplisit yang mendokumentasikan pelepasannya terhadap
jaminan append-only — bukan menonaktifkan trigger secara rutin.

## 15. Batasan saat ini

- Tanpa kontrol replay di frontend (di luar lingkup).
- Replay berjalan sinkron di proses yang sama; belum ada worker terpisah.
- Hanya `advance`/`set` waktu virtual; belum ada "seek" ke sekuens tertentu
  (tersedia `fromSeq`/`toSeq`/`maxObservations` untuk memotong rentang).
- Strategi/Jev belum ada, jadi perintah terjadwal masih manual.
- Depth penuh tidak direkam; eksekusi replay karena itu setara puncak buku.
- Klaim determinisme berlaku untuk proses yang sama; belum diuji lintas versi
  basis data atau lintas arsitektur CPU.

## 16. Cara pakai

```bash
# Rekam pasar live, putar ulang dua kali, bandingkan sidik jari
bun run smoke:record-replay

# Dengan satu order PAPER terjadwal
SMOKE_TRADE=1 bun run smoke:record-replay
```

Hasil terakhir: 554 observasi diproses ulang, hash gabungan **identik**
(`9f9931226c1d2785`) pada kedua putaran, wallet `999.99390590` pada keduanya.
Tidak ada order yang dikirim ke Gate.

## Replay lapisan intelijen (Phase 9)

`ReplayService` menerima `analytics?: AnalyticsService` dan meneruskannya ke
`onClosedCandle` `MarketRuntime` — titik masuk yang SAMA dengan live. Karena itu:

- Tidak ada `ReplayFeatureEngine` atau `BacktestScanner`.
- Candle tertutup dalam rekaman menggerakkan FeatureEngine + Scanner yang sama.
- `ReplayResult.analytics` memuat `counters` dan `digest` (hash riset kanonik).

Determinisme: dua replay atas rekaman yang sama menghasilkan
`digest.combinedHash`, distribusi reasonCode, dan counters yang identik
(`tests/phase9-replay.test.ts`). Hash riset tidak memuat id baris DB, jam
dinding, atau id acak.

Ekonomi tidak terpengaruh: replay dengan dan tanpa analytics menghasilkan
`hashes`/`balances` yang sama. Jadi scanner bisa dinyalakan tanpa mengubah
perilaku mesin ekonomi.

Catatan keterbatasan: rekaman yang pendek (mis. smoke 20 detik) tidak cukup
untuk warmup EMA200 (butuh >= 200 candle 5m). Syarat warmup tidak dilonggarkan;
untuk uji dipakai fixture sintetis >= 250 candle.

## Replay lapisan keputusan (Phase 10)

`ReplayService` menerima `decisions?: DecisionService`. Setelah runtime dibangun,
ia memasang `DecisionCoordinator` (memakai provider kutipan replay) ke handler
hasil scanner pada `AnalyticsService`. Engine keputusan yang dipakai adalah engine
murni yang SAMA seperti live — tidak ada `ReplayDecisionEngine`.

`ReplayResult.decisions` memuat `counters` dan `digest` (hash keputusan kanonik).
Dua replay atas rekaman yang sama menghasilkan `digest.combinedHash`, distribusi
reasonCode, dan counters yang identik.

Hash ekonomi replay (`hashes`/`balances`) **tidak berubah** saat keputusan
diaktifkan.

Keterbatasan yang disengaja: keputusan Phase 10 tidak mengeksekusi order, jadi
keadaan akun tetap sepanjang replay. Akun awal deterministik (mis. wallet 1000,
tanpa posisi) dipakai untuk setiap evaluasi, sehingga batas posisi tidak pernah
terisi. Keadaan akun otonom yang berkembang baru muncul saat eksekusi
dinyalakan di fase berikutnya.

Catatan: `ReplayMarketDataProvider.getBook`/`getMark` hanya mengembalikan keadaan
yang SUDAH terjadi, sehingga kutipan yang dipakai keputusan tidak pernah berasal
dari masa depan.

## Replay otonom (Phase 11)

`ReplayService` menerima `execution?: TradeExecutionService` dan
`tracker?: AutonomousTradeTracker`. Setelah runtime dibangun, keduanya dipasang
ke `DecisionCoordinator` (yang sudah memegang provider kutipan), sehingga jalur
replay memakai engine fitur/scanner/keputusan/eksekusi yang SAMA seperti live.

### Urutan per observasi

Satu observasi dapat memicu beberapa hal, jadi urutannya eksplisit:

1. `VirtualClock` dimajukan ke `observedAtMs`
2. observasi diterapkan ke `MarketState`
3. pemroses risiko menjalankan posisi LAMA (TP/SL/likuidasi) — dan memperbarui
   MAE/MFE dari mark yang sudah terjadi
4. candle tertutup → analitik (fitur → scanner)
5. keputusan dievaluasi terhadap keadaan akun CURRENT
6. eksekusi otonom (bila gate ON) → posisi baru
7. linkage & trade record dipersist

Poin penting: **posisi yang baru dibuat tidak dapat dipengaruhi secara
retrospektif oleh observasi yang sama** — langkah 3 berjalan sebelum langkah 6.
Ini mengikuti semantik `MarketRuntime` yang sudah ada (`onRiskTick` mendahului
`onClosedCandle` pada observasi yang sama), bukan urutan yang dipaksakan.

### Determinisme

Dua replay otonom dari rekaman dan akun awal yang sama menghasilkan `hashes`,
`balances`, jumlah order/fill/ledger, `trade_records`, dan metrik evaluasi yang
identik. Id order/fill/posisi disuntikkan deterministik
(`replay:<session>:order:N`, dst.) supaya ekonomi otonom dapat direproduksi.

A/B: eksekusi OFF mereproduksi perilaku Phase 10 (keputusan ada, ekonomi tidak
berubah); eksekusi ON menambah ekonomi PAPER.

Keterbatasan: karena Phase 11 hanya membuka posisi (exit milik Paper Exchange),
keadaan akun berkembang hanya bila ada TP/SL/likuidasi yang benar-benar kena
dalam jendela rekaman.

## Replay dengan perlakuan (Phase 12)

`ReplayService` menerima `treatment?: CandidateTreatment` dan
`onTreatment?: (result) => void`, lalu meneruskannya ke `DecisionCoordinator`.
Tanpa perlakuan, jalur replay persis seperti Phase 11.

`JevTreatment.evaluate` bersifat **SINKRON** dan hanya membaca cache
(`jev_evaluations`), sehingga loop replay deterministik tidak pernah menunggu
jaringan. Pengambilan evaluasi baru adalah langkah `collect` yang terpisah dan
asinkron, dijalankan SEBELUM replay treatment (lihat `tools/evaluate-ab.ts`).

Determinisme: rekaman sama + evaluasi tersimpan sama + config sama → treatment
result, keputusan, order, fill, ledger, trade record, metrik, dan hash yang
identik. Diuji dua run di `tests/phase12-treatment.test.ts`.

Batas determinisme: panggilan LLM eksternal tidak dianggap deterministik;
determinisme riset dimulai setelah evaluasi tertangkap.

## Mode replay dan koleksi (Phase 13)

Replay **tidak pernah** menyentuh jaringan Jev: ia hanya membaca evaluasi
tercached (`jev_evaluations`). Pengumpulan evaluasi baru terjadi di mode
RECORD + COLLECT atau lewat `bun run jev:backfill`, keduanya terpisah dari
replay (lihat `docs/COLLECTION.md`).

Label hasil (`candidate_outcome_labels`) dibangun OFFLINE dari rekaman dan tidak
pernah masuk jalur replay/keputusan. Replay deterministik tidak berubah oleh
kehadiran tabel label.
