# ADR 0012 — Lapisan Feature Engine & Hard Scanner yang murni dan terbagi live/replay

Status: diterima (Phase 9)
Tanggal: 2026-09-21

## Konteks

Phase 10+ akan menambahkan Decision Engine dan evaluasi Jev. Keduanya butuh
deskripsi pasar yang deterministik dan dapat direproduksi, serta tidak boleh
mencampur "apa yang terjadi di pasar" dengan "berapa uang yang dipakai".
Phase 8 sudah menyediakan rekaman observasi dan replay deterministik, tetapi
belum ada lapisan interpretasi.

## Keputusan

1. **Inti murni di `packages/core/src/analytics/`.** Feature Engine dan Scanner
   hanya menerima candle tertutup + konfigurasi, dan hanya mengeluarkan
   `FeatureSnapshot`/`ScannerResult`. Dilarang: DB, repository, service ekonomi,
   saldo, leverage, HTTP, WebSocket, `Date.now()`, `Math.random()`. Ditegakkan
   test yang memindai kode sumber (setelah komentar dibuang) dan memastikan
   impor hanya dari dalam inti atau dependensi murni (`zod`, `decimal.js`).
2. **Hanya candle tertutup 5m.** Mark/bid/ask milik lapisan eksekusi/risiko.
   Candle yang belum tertutup diabaikan (`not_closed`), sehingga tidak ada
   sinyal intrabar dan tidak ada look-ahead.
3. **Satu implementasi untuk live dan replay.** Tidak ada `ReplayFeatureEngine`
   atau `BacktestScanner`. `AnalyticsService` dipasang ke `onClosedCandle`
   `MarketRuntime`, yang dipakai jalur live maupun replay.
4. **Kandidat ≠ sinyal.** Scanner memisahkan "setup layak dievaluasi" dari
   "aturan deterministik menunjuk LONG/SHORT/NETRAL", supaya perbandingan
   baseline vs Jev nanti tidak kehilangan informasi.
5. **Alat analisis observasional.** Kegagalan analitik tidak boleh menghentikan
   ingest pasar, risk processing, atau paper trading manual. `onClosedCandle`
   tidak pernah melempar; kegagalan dihitung di `counters.errors`.
6. **Persistensi riset terpisah.** `feature_snapshots` (Phase 1, kini berunique
   index per versi) dan `scanner_results` (baru). Keduanya bukan `domain_events`
   dan bukan `decisions`.
7. **Hashing riset non-kripto.** `fingerprint` FNV-1a yang sudah ada dipakai agar
   inti tetap tanpa `node:crypto`. Hash tidak memuat id baris, jam dinding, atau
   id acak.

## Konsekuensi

- Dua replay atas rekaman yang sama menghasilkan `combinedHash` identik; ini
  menjadi dasar regresi riset (fixture golden 280 candle).
- Definisi indikator terkunci di `features-v1`; perubahan seed/smoothing wajib
  menaikkan versi agar dataset tidak tercampur.
- Scanner tidak dapat menambah order/leverage tanpa melanggar guard impor dan
  test kunci hasil.
- Ambang indikator disimpan di config yang dapat di-hash, sehingga eksperimen
  dapat dibandingkan secara jujur.
- Indikator tidak dibulatkan ke 8 dp; nilainya desimal analitik, bukan uang
  ledger.

## Alternatif yang ditolak

- **Menghitung fitur pada setiap update ticker/book**: tidak deterministik,
  memunculkan sinyal intrabar yang tidak stabil, dan membuka jalan look-ahead.
- **Menyimpan hasil scanner di `domain_events`**: mencemari outbox ekonomi
  dengan data analitik tanpa makna transaksional.
- **Menyimpan hasil scanner di `decisions`**: `decisions` adalah tempat keputusan
  ekonomi (ukuran, leverage, SL/TP) yang belum ada di Phase 9.
- **Engine berbasis jendela geser (sliding window)**: EMA bergantung pada seed
  awalnya, sehingga jendela geser menghasilkan nilai berbeda dari EMA riwayat
  penuh dan rusak begitu panjang warmup berubah. Keadaan rekursif dipilih.
