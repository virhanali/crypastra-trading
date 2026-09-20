# ADR 0016 — Jev sebagai perlakuan probabilistik yang gagal-tertutup

Status: diterima (Phase 12)
Tanggal: 2026-09-21

## Konteks

Phase 11 menetapkan baseline kontrol deterministik (fitur → scanner → keputusan →
risk-v1 → eksekusi PAPER → trade record → metrik). Untuk mengukur nilai
"kecerdasan" sebagai PERLAKUAN, perlu lapisan yang dapat memveto kandidat tanpa
mengubah satu pun komponen kontrol.

## Keputusan

1. **Perlakuan adalah abstraksi, bukan `if (jev)` tersebar.** `CandidateTreatment`
   dengan dua implementasi: `NoTreatment` (CONTROL) dan `JevTreatment` (TREATMENT).
   DecisionEngine/RiskEngine/OrderService tidak tahu Jev ada.
2. **Jev pra-risiko dan hanya untuk kandidat.** Perlakuan berjalan setelah scanner
   menghasilkan kandidat, sebelum DecisionEngine. Warmup/skip biasa tidak
   memanggil Jev.
3. **Jev hanya menghasilkan probabilitas.** Empat evaluator terpisah
   (`trend_alignment`, `momentum_sustainability`, `reversal_risk`, `btc_regime`).
   Tidak ada "AI confidence" generik. Probabilitas terpisah dan bermakna sendiri.
4. **Kebijakan veto deterministik dan murni.** `jev-veto-v1` memutuskan
   ALLOW/VETO dari probabilitas + satu config ter-hash. Ambang tidak dioptimasi,
   dan jarak ke ambang tidak dipakai untuk leverage/ukuran.
5. **FAIL CLOSED.** Jev tidak tersedia / timeout / output tidak valid →
   `unavailable`/`invalid` → kandidat tidak ditradingkan. Tidak ada fallback
   diam-diam ke baseline di run berlabel treatment.
6. **Output eksternal tidak dipercaya.** Validasi ketat (zod `.strict()`):
   evaluator, versi skema, rentang probabilitas, bentuk JSON. Tidak ada nilai
   trading dari prosa.
7. **Cache sebagai identitas.** `(inputHash, evaluator, evaluatorVersion,
   promptVersion, schemaVersion, provider, model)`. `evaluate` bersifat SINKRON
   dan hanya membaca cache; pengambilan jaringan adalah langkah `collect`
   terpisah. Ini membuat replay deterministik tanpa menunggu jaringan.
8. **Port di inti, adapter di `packages/adapters`.** Inti tidak tahu HTTP/SDK/
   kredensial. `RealJevAdapter` membaca config dari env, memakai timeout
   `AbortController`, dan tidak pernah mempersist rahasia.
9. **Persistensi audit.** `jev_evaluations` (per evaluator, sekaligus cache) dan
   `treatment_results` (ALLOW/VETO per kandidat). Keduanya bukan tabel ekonomi.
10. **Perlakuan tidak pernah menyentuh risiko posisi terbuka.** Likuidasi, TP,
    SL, funding, dan penutupan manual tetap milik Paper Exchange.

## Konsekuensi

- CONTROL tetap beku: tanpa perlakuan, output identik dengan Phase 11 (hash
  ekonomi `cd0b21520c4945b6` tidak berubah).
- Jev tidak dapat mengubah ukuran/leverage/SL/TP — `decide()` tidak menerima
  parameter perlakuan, ditegakkan guard impor.
- Determinisme riset dimulai setelah evaluasi tertangkap; dua run dengan cache
  sama menghasilkan hash dan metrik identik.
- `experimentHash` CONTROL berubah dibanding Phase 11 karena deskriptor
  eksperimen kini memuat bidang perlakuan; ini disengaja dan tidak menyentuh
  hash ekonomi.
- Fail-closed berarti rekaman tanpa evaluasi Jev menghasilkan nol trade pada arm
  treatment — perilaku yang benar untuk eksperimen, bukan kegagalan.

## Alternatif yang ditolak

- **Jev memilih arah/size/leverage**: melanggar pemisahan kontrol dan membuat
  eksperimen tidak dapat ditafsirkan.
- **Fallback ke baseline saat Jev gagal**: mengontaminasi run treatment.
- **Menganggap panggilan LLM deterministik**: determinisme harus dimulai dari
  evaluasi tertangkap, bukan dari jaringan.
- **Menebar `if (jev)` di DecisionEngine**: menyulitkan audit dan mengaburkan
  batas kontrol/perlakuan.
