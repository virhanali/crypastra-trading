# ADR 0014 — Eksekusi PAPER otonom yang bergerbang dan evaluasi baseline

Status: diterima (Phase 11)
Tanggal: 2026-09-21

## Konteks

Phase 10 menghasilkan `TradePlan` deterministik yang disetujui, tetapi secara
sengaja berhenti sebelum OrderService. Untuk mengukur baseline sebagai kelompok
kontrol sebelum Jev, rencana yang disetujui perlu dihubungkan ke mesin ekonomi
PAPER yang sudah ada — tanpa membuka jalan ke eksekusi nyata dan tanpa
menciptakan sistem idempotensi atau backtesting kedua.

## Keputusan

1. **Gate eksplisit, default OFF.** Eksekusi memerlukan `CRYPASTRA_DECISIONS=1`
   DAN `CRYPASTRA_EXECUTION=1` DAN akun eksplisit. Gate OFF bersifat inert:
   tidak memanggil OrderService dan tidak menulis baris apa pun, termasuk
   linkage.
2. **Lapisan tipis, tanpa perhitungan ulang.** `TradeExecutionService` memetakan
   TradePlan → OrderIntent apa adanya, menurunkan command id deterministik, dan
   memanggil OrderService PAPER. Ia tidak menghitung ulang indikator, ukuran,
   leverage, atau SL/TP.
3. **Idempotensi memakai arsitektur yang ada.** `commandId = "auto-entry:" +
   decisionId`, dan OrderService sudah idempoten pada `commandId`. Tidak ada
   sistem idempotensi kedua. `decision_executions` unik per `decision_id`
   melengkapi linkage, bukan menggantikan idempotensi.
4. **Harga acuan bukan harga isian.** TradePlan.referencePrice adalah konteks
   perencanaan; OrderService memakai kutipan PAPER saat itu. Slippage dan drift
   risiko **diukur**, tidak disembunyikan, dan ukuran/SL tidak disesuaikan
   setelah isian.
5. **SKIP tidak dapat dieksekusi secara struktural**, bukan lewat disiplin
   pemanggil.
6. **Exit tetap milik Paper Exchange.** Tidak ada mesin exit kedua; TP/SL,
   likuidasi, dan penutupan manual tetap semantik Phase 4.
7. **Keadaan akun berkembang, tanpa cache.** `AccountRiskState` dibangun ulang
   dari keadaan current setelah setiap efek ekonomi, sehingga batas posisi dan
   margin benar-benar mengikat.
8. **TradeRecord adalah materialisasi DERIVED** untuk evaluasi; sumber kebenaran
   ekonomi tetap orders/fills/positions/ledger. Tabel `trade_records` terpisah
   dari `decisions` dan `decision_executions` agar tujuan tiap tabel jelas.
9. **Metrik deskriptif, tanpa Sharpe.** Profit factor tanpa kerugian dilaporkan
   `null`. Drawdown memakai kurva ekuitas realisasi trade otonom, tidak
   mencampur ekuitas belum terealisasi.
10. **Tidak ada Jev/LLM/optimasi.** Baseline diukur apa adanya.

## Konsekuensi

- Replay otonom dua kali menghasilkan hash ekonomi, trade record, dan metrik
  yang identik; ini menjadi acceptance test utama Phase 11.
- A/B eksplisit: eksekusi OFF mereproduksi perilaku Phase 10 (keputusan ada,
  ekonomi tidak berubah).
- Restart aman: command id deterministik membuat OrderService mengenali
  percobaan ulang sebagai duplikat.
- Keterbatasan terdokumentasi: ukuran desimal (`enable_decimal`) tidak dapat
  dieksekusi karena `OrderIntentSchema.size` integer; keputusan seperti itu
  dicatat `skipped` dengan `SIZE_NOT_EXECUTABLE`.

## Alternatif yang ditolak

- **Mengaktifkan eksekusi secara default**: otonomi harus opt-in eksplisit.
- **Sistem idempotensi kedua di lapisan eksekusi**: OrderService sudah
  transaksional dan idempoten; menduplikasinya akan menciptakan dua sumber
  kebenaran.
- **Memakai `referencePrice` sebagai harga isian**: menyembunyikan pergerakan
  pasar dan membuat metrik slippage tidak bermakna.
- **Menyesuaikan ukuran/SL setelah isian**: akan menyamarkan drift risiko dan
  melanggar "TradePlan otoritatif".
- **Mesin exit strategi kedua**: duplikasi semantik TP/SL yang sudah ada.
- **Melonggarkan `OrderIntentSchema.size` menjadi desimal**: perubahan pada
  fondasi Phase 3; ditunda dan didokumentasikan sebagai keterbatasan.
