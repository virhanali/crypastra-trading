# 0002 — Uang sebagai Decimal string, bukan number/float

- Status: diterima
- Tanggal: 2026-09-20

## Konteks

Paper Exchange adalah sistem akuntansi finansial. Permintaan user eksplisit:
"Use decimal/fixed-point monetary calculations. Do NOT use float64 for financial
accounting."

Environment memaksa masalah ini jadi konkret: SQLite tidak punya tipe desimal asli.
`REAL` = float64. `NUMERIC` di SQLite akan disimpan sebagai REAL bila nilainya bukan
integer. Jadi "simpan desimal di DB" bukan pilihan yang tersedia secara native.

## Keputusan

1. Gunakan `decimal.js` di `packages/core` sebagai satu-satunya aritmetika uang.
2. Simpan uang di SQLite sebagai `TEXT` (decimal string), bukan `REAL`/`NUMERIC`.
3. Konfigurasi eksplisit: `precision: 40`, `ROUNDING: ROUND_HALF_UP`.
4. Pembulatan **eksplisit per operasi**, bukan hanya di akhir: fee `ROUND_UP`,
   initial margin `ROUND_UP`, available balance `ROUND_DOWN`, harga sesuai
   `order_price_round` kontrak, uang tersimpan 8 dp.
5. `number` dilarang untuk harga, notional, margin, PnL, fee, funding, saldo, rate.
   `number` hanya untuk: UI/charting, statistik non-finansial, timestamp, dan
   counter loop.
6. Konversi `string ↔ Decimal` hanya di batas: adapter (masuk) dan repository/UI
   (keluar).
7. `Decimal` adalah **class**, sehingga `DecimalSchema` di zod menyimpan nilai sebagai
   string. Skema zod menerima string dan memvalidasi parseability, tidak mengembalikan
   objek Decimal ke JSON.

## Alasan

- Gate.io mengirim semua angka order book/harga/fee sebagai **string**
  (`"80436.8"`, `"0.00075"`, `quanto_multiplier: "0.0001"`). Tidak ada alasan untuk
  mengubahnya jadi float di tengah jalan dan kehilangan presisi.
- `maker_fee_rate` untuk BTC_USDT = `-0.0001` dan fee dihitung pada notional kecil
  (`order_size_min = 1` → notional ~$8 → taker fee ~$0.006). Float64 pada akumulasi
  ribuan fill akan menghasilkan drift yang terlihat di rekonsiliasi ledger.
- Teks juga membuat audit ledger deterministik: `balance_after` bisa dibandingkan
  byte-per-byte.

## Konsekuensi

- Semua query agregasi uang harus mengembalikan string dan dijumlahkan dengan
  `Decimal` di kode, bukan `SUM()` di SQL (SQLite akan mem-float-kan `SUM` pada text
  yang ter-parse sebagai angka). Alternatif: `SUM(CAST(col AS TEXT))` tetap tidak
  aman → keputusan: agregasi di aplikasi.
- Index/range query pada kolom uang jadi lexicographic bila dilakukan di SQL. Karena
  kita tidak butuh range query uang (hanya exact match dan urutan `seq`), ini tidak
  masalah. Kalau nanti butuh sorting numerik, tambahkan kolom turunan `*_micros`
  (INTEGER, skala tetap) — bukan mengubah kolom uang utama.
- Butuh guard: test yang memindai `schema.ts` untuk memastikan tidak ada kolom uang
  bertipe `real()`/`numeric()`, dan review untuk menolak `Number()` pada nilai uang.
- Perlu adapter `zod` untuk Decimal (`MoneySchema`) yang dipakai bersama API dan core.

## Verifikasi

- Test: `Decimal("0.1").plus("0.2").toString() === "0.3"`.
- Test: round-trip DB untuk `"0.12345678"` identik.
- Test: scan skema DB tidak memuat kolom uang bertipe float.
- Fixture: `size=1, price=80000, leverage=10` → margin `0.8`, taker fee `0.006`,
  maintenance `0.024` (lihat `docs/gateio-market-data.md` §3).