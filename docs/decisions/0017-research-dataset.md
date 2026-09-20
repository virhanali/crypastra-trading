# ADR 0017 — Dataset riset: rekaman nyata, koleksi Jev terbatas, label terpisah

Status: diterima (Phase 13)
Tanggal: 2026-09-21

## Konteks

Phase 12 menambahkan Jev sebagai perlakuan dengan cache, tetapi belum ada cara
mengumpulkan data nyata secara kontinu, menutup celah funding, mengevaluasi
kandidat dengan label masa depan, atau mengekspor dataset yang reproducible.
Tanpa itu, pertanyaan "apakah Jev berguna" tidak dapat dijawab secara jujur.

## Keputusan

1. **Empat mode dipisah tegas** (§37): RECORD ONLY, RECORD + COLLECT, BACKFILL,
   REPLAY. Hanya RECORD + COLLECT dan BACKFILL yang menyentuh jaringan Jev;
   REPLAY nol jaringan.
2. **Perekam memakai jalur publik yang sudah ada.** `GateioMarketDataProvider` +
   `MarketRecorder` Phase 8. Tanpa API key, tanpa kanal privat, universe kecil
   (BTC_USDT, ETH_USDT) — tidak merekam ~1000 kontrak.
3. **Resumability eksplisit.** Universe identik → lanjutkan sesi; berbeda →
   tutup `aborted` dan buat sesi baru. Konfigurasi berbeda tidak pernah
   dicampurkan diam-diam.
4. **Kolektor asinkron dan terbatas.** `LiveJevCollector` tidak pernah memblokir
   ingest; antrean penuh → buang + catat. Kapasitas mencakup pekerjaan in-flight.
5. **Kebijakan retry eksplisit dan terbatas.** retryable (timeout/429/5xx) →
   retry terbatas; invalid → tidak diulang; auth → fatal. Retry tidak pernah
   menggandakan evaluasi karena identitas cache Phase 12 otoritatif.
6. **Kelengkapan kandidat adalah konsep kelas satu.** 3/4 evaluator bukan
   `complete`, dan perlakuan tidak dijalankan tanpa kelengkapan.
7. **Label terpisah total dari evaluasi Jev.** Tabel
   `candidate_outcome_labels` terpisah; baris Jev tidak pernah dimutasi dengan
   informasi masa depan. Guard impor membuktikan jalur perlakuan/keputusan/
   eksekusi tidak dapat membaca label.
8. **Definisi label fixed dan berversi.** `outcome-label-v1` dengan horizon
   `[1,3,6,12]`, satu sumber harga (OHLC candle), ambang tren 0.25%, momentum
   (return > 0 dan MAE ≤ 1×ATR), reversal (MAE ≥ 1.5×ATR). Tidak ada ambang yang
   disetel dari hasil Jev.
9. **EMA200 tetap mengikat.** Kesiapan dataset tidak pernah memperlonggar warmup.
10. **Ekspor deterministik dan bebas privasi.** JSONL urutan kanonik; hash tidak
    memuat id DB/jam dinding; tidak ada akun/wallet/rahasia.
11. **Bucket probabilitas hanya deskriptif.** Tidak ada rekomendasi ambang dan
    tidak ada klaim kalibrasi; analisis statistik adalah fase berikutnya.

## Konsekuensi

- Dataset dapat dikumpulkan bertahap: rekam pasar dulu (jam-jaman), kumpulkan Jev
  kemudian, labeli, ekspor — tanpa kehilangan validitas eksperimen.
- Kegagalan Jev (mati/timeout/antrean penuh/output cacat) tidak pernah
  menghentikan penangkapan pasar.
- Kontrol dan perlakuan Phase 12 tidak berubah: hash ekonomi kontrol
  `cd0b21520c4945b6` dan perilaku golden treatment tetap.
- Karena tidak ada rekaman nyata panjang di repo, seluruh angka uji berasal dari
  fixture sintetis; koleksi nyata masih memerlukan jam runtime.

## Alternatif yang ditolak

- **Koleksi Jev sinkron di jalur ingest**: akan membekukan pemrosesan risiko dan
  TP/SL.
- **Antrean tak terbatas**: pertumbuhan memori tak terkendali.
- **Menyimpan label di baris Jev**: mencampur masa depan dengan input, membuka
  kebocoran dan merusak reproduksibilitas.
- **Memperlonggar warmup EMA200 agar dataset cepat terpakai**: mengubah
  `features-v1` dan membuat kandidat tidak sebanding.
- **Memakai mark untuk label**: mencampur sumber harga dengan MAE/MFE TradeRecord.
