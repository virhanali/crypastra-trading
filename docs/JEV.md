# Jev — perlakuan probabilistik (`treatment-v1`, `jev-veto-v1`)

Implementasi: `packages/core/src/treatment/` (murni), `packages/adapters/src/jev/`
(port konkret), `apps/server/src/repositories/jev-evaluation-repository.ts`.

Jev adalah **PERLAKUAN EKSPERIMENTAL**, bukan bagian dari kontrol. Ia menjawab
"seberapa PROBABEL properti tertentu dari kandidat ini?", BUKAN "LONG atau SHORT?".

Jev **tidak** menentukan: ukuran, leverage, stop loss, take profit, alokasi
wallet, margin, tipe order, eksekusi, atau PnL.

```
FeatureSnapshot + ScannerResult + konteks BTC
      ↓
evaluator Jev (probabilitas)
      ↓
kebijakan veto DETERMINISTIK (jev-veto-v1)
      ↓
allow | veto | unavailable | invalid
      ↓
DecisionEngine + risk-v1  (TIDAK BERUBAH)
      ↓
eksekusi PAPER yang sudah ada
```

## Batas

Jev berjalan **sebelum risiko** dan hanya untuk **kandidat scanner**
(`status = candidate`). Warmup/skip biasa tidak memanggil Jev. Jev tidak pernah
memveto risiko posisi yang sudah terbuka: likuidasi, TP, SL, funding, dan
penutupan manual tetap deterministik dan berprioritas lebih tinggi.

Kode perlakuan **dilarang** mengimpor/memanggil `OrderService`,
`TradeExecutionService`, `LedgerRepository`, `AccountRepository`,
`PositionRepository`, mesin matching, atau internal sizing risiko. Adapter Jev
tidak tahu Paper Exchange ada. Sebaliknya `risk-v1` tidak mengimpor Jev.
Ditegakkan guard sumber di `tests/phase12-treatment.test.ts`.

## Kontrak input

`JevInput` (ringkas, berversi, HANYA konteks pasar/riset):

`contract, timeframe, candleCloseTimeMs, direction`, `close`, EMA20/50/200,
jarak dari EMA20/50/200, `rsi14`, `macd`, `macdSignal`, `macdHistogram`,
`atr14`, `atrPercent`, `return1/3/12`, `volumeRatio`, `trendStructure`,
status/setup/reasonCodes/facts scanner, konteks BTC (trend, return1, return12,
atrPercent), dan versi/hash fitur+scanner.

TIDAK memuat: account id, wallet, equity, margin tersedia, leverage, budget
risiko, ukuran posisi, PnL, hasil trade sebelumnya. Tidak ada informasi masa
depan: input di candle `T` hanya memuat informasi tersedia pada atau sebelum `T`.

## `jevInputHash`

Hash kanonik FNV-1a atas bidang input yang eksplisit (tanpa jam dinding, id DB,
UUID, atau keadaan akun). Keadaan pasar/scanner yang sama → hash yang sama.
Ini menjadi identitas cache dan bukti bahwa tidak ada data akun/masa depan yang
bocor ke Jev.

## Evaluator V1

| evaluator | pertanyaan | output |
|---|---|---|
| `trend_alignment` | probabilitas struktur tren mendukung arah kandidat pada horizon dekat | `probability` |
| `momentum_sustainability` | probabilitas momentum arah bertahan, bukan langsung memudar | `probability` |
| `reversal_risk` | probabilitas reversal material jangka dekat melawan arah kandidat | `probability` |
| `btc_regime` | kondisi BTC mendukung/netral/hostil untuk arah kandidat | `regime{supportive,neutral,hostile}` |

Probabilitas bersifat **terpisah dan bermakna sendiri**:
`trend_alignment = 0.8` tidak sama artinya dengan `reversal_risk = 0.8`.
Tidak ada "AI confidence" generik yang dipakai untuk trading.

Setiap evaluator membawa `evaluatorVersion`, `promptVersion`, `schemaVersion`.
Mengubah instruksi evaluator WAJIB menaikkan versi prompt; tidak boleh menyunting
prompt sambil mempertahankan versi lama.

## Validasi output (input eksternal tidak dipercaya)

Output divalidasi ketat (zod `.strict()`): evaluator harus sesuai, `schemaVersion`
harus dikenal, probabilitas harus string desimal dalam `[0,1]`, JSON cacat/field
tak dikenal ditolak, dan `btc_regime` wajib membawa tiga probabilitas.
**Tidak ada nilai trading yang diekstrak dari prosa.**

## Kebijakan gagal: FAIL CLOSED

Bila Jev tidak tersedia, timeout, atau outputnya tidak valid, status perlakuan
menjadi `unavailable`/`invalid` dan kandidat **TIDAK** ditradingkan.

Tidak ada fallback diam-diam ke baseline di dalam run berlabel "jev treatment",
karena itu akan mengontaminasi eksperimen. Reason code eksplisit:
`JEV_UNAVAILABLE`, `JEV_INVALID_OUTPUT`, `JEV_EVALUATION_MISSING`.

## Cache & identitas

Identitas cache = `(inputHash, evaluator, evaluatorVersion, promptVersion,
schemaVersion, provider, model)`. Identitas yang sama → hasil tersimpan dipakai
ulang; replay retry tidak menghasilkan panggilan eksternal kedua. Mengubah
prompt/evaluator/model menghasilkan identitas BARU (hasil lama tidak ditimpa).

Dua mode replay (§29):
- **recorded/cached** — memakai evaluasi tersimpan; tanpa jaringan; deterministik.
- **collect** — evaluasi yang hilang boleh memanggil adapter nyata, lalu
  disimpan; replay berikutnya offline.

`JevTreatment.evaluate` bersifat **sinkron** dan hanya membaca cache, sehingga
jalur replay deterministik tidak pernah menunggu jaringan.

## `jev-veto-v1`

Config tunggal yang dapat diserialisasi dan di-hash:

| kunci | default | arti |
|---|---|---|
| `minimumTrendAlignment` | `"0.55"` | probabilitas minimum trend alignment |
| `minimumMomentumSustainability` | `"0.55"` | probabilitas minimum momentum bertahan |
| `maximumReversalRisk` | `"0.45"` | probabilitas maksimum reversal risk |
| `maximumBtcHostileProbability` | `"0.5"` | maksimum P(hostile) BTC |
| `requireBtcEvaluator` | `false` | wajibkan evaluator BTC dan aktifkan ambangnya |

Default bersifat **EKSPERIMENTAL**, bukan hasil optimasi, dan tidak dioptimasi
terhadap hasil replay. Jarak probabilitas ke ambang TIDAK dipakai untuk
menurunkan leverage atau ukuran apa pun.

Aturan (deterministik, urut):

1. evaluator wajib hilang → `unavailable` (`JEV_EVALUATION_MISSING`)
2. evaluator tidak tersedia → `unavailable` (`JEV_UNAVAILABLE`)
3. evaluator tidak valid → `invalid` (`JEV_INVALID_OUTPUT`)
4. `p_trend < minimumTrendAlignment` → VETO `JEV_TREND_ALIGNMENT_BELOW_MINIMUM`
5. `p_momentum < minimumMomentumSustainability` → VETO `JEV_MOMENTUM_UNSUSTAINABLE`
6. `p_reversal > maximumReversalRisk` → VETO `JEV_REVERSAL_RISK_TOO_HIGH`
7. `requireBtcEvaluator` DAN `P(hostile) > maximumBtcHostileProbability` → VETO `JEV_BTC_REGIME_HOSTILE`
8. selain itu → ALLOW `JEV_TREATMENT_ALLOWED`

Ambang BTC **hanya** berlaku bila `requireBtcEvaluator = true`; tanpa itu
probabilitas BTC tetap terekam untuk riset tetapi tidak memveto.

## Persistensi

`jev_evaluations` — satu baris per evaluator, sekaligus cache. Memuat input hash,
identitas kandidat, versi evaluator/prompt/skema, provider/model, probabilitas,
status (`success|invalid|unavailable|error`), reason codes, output tervalidasi,
metadata aman, input kanonik, dan opsional latency/token.

`treatment_results` — hasil perlakuan per kandidat (`allow|veto|unavailable|invalid`
+ reason codes + evaluasi). Audit trail untuk analisis A/B; bukan tabel ekonomi.

Tidak ada rahasia yang dipersist: metadata dibatasi pada kunci aman, dan
kredensial hanya dipakai di header permintaan.

## Observability

`JevUsageCounters`: `requests`, `cacheHits`, `cacheMisses`, `successes`,
`invalid`, `unavailable`, `errors`, `inputTokens`, `outputTokens`.

Latency dicatat untuk adapter nyata, tetapi **latency jam dinding tidak pernah
masuk hash perlakuan atau keputusan trading**.

## Timeout, backpressure, kesegaran

Setiap panggilan eksternal dibatasi `timeoutMs` (default 5s, `AbortController`
pada adapter nyata). Timeout → `unavailable` → fail closed. Tidak ada antrean
evaluator tak terbatas, dan ingest pasar / pemrosesan risiko / TP-SL tidak
pernah menunggu Jev.

Perlakuan terikat pada identitas kandidat (kontrak + waktu tutup candle). Bila
hasil datang setelah kandidat tidak lagi valid untuk dieksekusi, hasil itu tidak
dieksekusi; eksekusi live tetap mensyaratkan kutipan segar.

## Mode live

`CRYPASTRA_JEV=1` (default OFF), dan tetap memerlukan `CRYPASTRA_DECISIONS=1`
plus akun eksplisit. Live V1 memakai mode **observasi berbasis cache**: evaluasi
dibaca dari cache (tanpa panggilan jaringan di jalur ingest); pengambilan
evaluasi baru dilakukan lewat `bun run smoke:jev` (opt-in, tidak pernah di CI).

Kombinasi yang didukung: keputusan ON + Jev ON + eksekusi OFF (amati Jev saja),
atau ketiganya ON (eksekusi PAPER yang difilter Jev). **Tidak pernah** trading
nyata.

## Privasi

Tidak ada API key, account id, wallet, ledger, atau identifier pengguna yang
dikirim ke Jev — hanya konteks pasar/riset. Payload keluar diuji di
`tests/phase12-treatment.test.ts`.

## Label masa depan tetap offline

PnL, MFE, MAE, hasil trade, dan candle masa depan TIDAK pernah masuk ke Jev.
Itu label evaluasi, bukan input.

## Koleksi dan label (Phase 13)

Pengumpulan evaluasi Jev nyata dilakukan kolektor asinkron terbatas
(`docs/COLLECTION.md`): antrean penuh → buang + catat, retry terbatas, invalid
tidak diulang, auth fatal. Ingest pasar tidak pernah menunggu Jev.

Label hasil masa depan (`outcome-label-v1`) dibangun **offline** dan disimpan
terpisah di `candidate_outcome_labels`. Label **tidak pernah** dikirim ke Jev dan
tidak dapat dibaca jalur perlakuan/keputusan/eksekusi.
