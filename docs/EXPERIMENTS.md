# Eksperimen A/B (`evaluation-v1`, `treatment-v1`)

Harness: `tools/evaluate-ab.ts` (`bun run evaluate:ab -- <sessionId>`).

Tujuan: membandingkan **CONTROL** (tanpa perlakuan) dengan **TREATMENT** (Jev)
secara reproducible, lalu melaporkan perbedaan secara **deskriptif**.

## Metodologi

Kedua arm memakai:

- rekaman pasar yang sama dan urutan observasi yang sama
- wallet awal dan keadaan akun awal yang sama
- `features-v1`, `scanner-v1`/config, `decision-v1`, `risk-v1`, `execution-v1`,
  `evaluation-v1` yang sama

Yang berbeda **hanya** perlakuan. Setiap arm memakai DB terisolasi (salinan utuh
DB sumber via `VACUUM INTO`), sehingga tidak ada kontaminasi antar arm.

Urutan eksekusi harness:

1. Arm CONTROL dijalankan (NoTreatment) → keputusan, trade, metrik, dan artefak
   fitur/scanner.
2. **Collect**: kandidat dibaca dari artefak arm CONTROL; `JevInput` dibangun
   untuk setiap kandidat; evaluasi yang hilang diambil dari adapter (fake untuk
   CI) dan dipersist ke DB arm treatment. Tidak ada jaringan pada arm replay.
3. Arm TREATMENT dijalankan dengan `JevTreatment` yang membaca cache → deterministik.

## Identitas eksperimen

`BaselineExperiment` diperluas dengan perlakuan:

- CONTROL: `treatment = none`
- TREATMENT: `kind = jev`, `treatmentVersion`, `treatmentConfigHash`,
  versi evaluator/prompt/skema, dan identitas provider/model

Semua bidang lain identik. `experimentHash` kedua arm dilaporkan berdampingan.
Perubahan pada deskriptor eksperimen (menambahkan perlakuan) berarti hash
eksperimen CONTROL berbeda dari Phase 11 — hash **ekonomi** tidak berubah.

## Keluaran

Kompak: recording, kedua experiment hash, jumlah kandidat
(keputusan/trade kontrol; allow/veto/unavailable treatment), usage Jev
(requests/cacheHits/cacheMisses/success/invalid/unavailable), metrik
berdampingan (`tradeCount`, `winRate`, `netPnl`, `expectancyPerTrade`,
`expectancyR`, `profitFactor`, `maxDrawdown`, `maxDrawdownPct`, `averageR`,
`averageMAE`, `averageMFE`), `tradesRemovedByTreatment`, distribusi reason code
veto, dan analisis matched-trade.

Tidak ada skor tunggal "seberapa bagus Jev".

## Analisis matched-trade

Untuk setiap trade CONTROL, perlakuan pada identitas kandidat yang sama
diklasifikasikan: `allowed` / `vetoed` / `unavailable` (kunci:
`contract:candleCloseTime:direction`). Untuk trade CONTROL yang **diklasifikasi
vetoed**, hasil baseline-nya dilaporkan:

- `vetoed winners` / `vetoed losers` / `vetoed breakeven`
- `totalR` dari trade yang diveto

Ini menjawab apakah Jev membuang trade buruk atau justru trade baik — tanpa
menyimpulkan sebab-akibat.

## Batas determinisme

Panggilan LLM eksternal TIDAK dianggap deterministik. Determinisme riset dimulai
**setelah** evaluasi tertangkap: rekaman sama + evaluasi tersimpan sama + config
sama → treatment result, keputusan, order, fill, ledger, trade record, metrik,
dan hash yang identik. Diuji dua run
(`tests/phase12-treatment.test.ts`).

## Bahasa pelaporan

Alat melaporkan **perbedaan deskriptif**: delta expectancy, delta drawdown,
delta R, jumlah trade yang dihapus. Alat **tidak** mencetak "Jev memperbaiki
strategi". Evaluasi statistik menyusul di fase berikutnya.

## Batasan

- Analisis hanya deskriptif untuk satu rekaman; tidak ada uji signifikansi.
- Tanpa rekaman nyata yang cukup panjang, hasil hanya berasal dari fixture
  sintetis (dilaporkan jujur).
- `evaluate:ab` menjalankan arm secara berurutan pada DB terpisah; ia bukan
  orkestrator paralel.

## Dataset dan kualitas (Phase 13)

Eksperimen kini dapat berjalan di atas dataset yang dikumpulkan bertahap:
rekam pasar, kumpulkan Jev (live atau backfill), labeli hasil, lalu ekspor
(`docs/DATASET.md`). `dataset:status` melaporkan kesiapan (EMA200 mengikat) dan
kualitas (cakupan Jev, cakupan label, class balance, bucket probabilitas
deskriptif). Tidak ada rekomendasi ambang dan tidak ada klaim kalibrasi —
analisis statistik adalah fase berikutnya.
