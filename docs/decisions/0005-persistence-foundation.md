# 0005 — Fondasi persistensi: codec eksplisit, transaksi IMMEDIATE, ledger append-only

- Status: diterima
- Tanggal: 2026-09-20
- Melanjutkan: 0001 (runtime), 0002 (decimal money), 0004 (batas domain)

## Konteks

Phase 1 membangun persistensi paper exchange. Empiris yang membentuk keputusan ini:

1. **drizzle-kit berjalan sebagai CJS.** Memuat `schema.ts` lewat `require`. Karena
   `@crypastra/core` ESM-only (`exports` tanpa kondisi `require`), schema yang
   mengimpor core secara runtime gagal: `ERR_PACKAGE_PATH_NOT_EXPORTED`. Ini alasan
   piastra hanya memakai `import type` di schema-nya.
2. **Presisi Gate.io heterogen dan ekstrem.** Probe 997 kontrak USDT (20 Sep 2026):
   `order_price_round` sampai **11 dp** (`SATS_USDT` = `0.00000000001`, 6 kontrak
   melebihi 8 dp); `quanto_multiplier` 0.0001–10000000; `maker_fee_rate` **selalu
   negatif** di semua 997 kontrak; tidak ada notasi eksponen di mana pun.
3. **SQLite tidak punya row lock.** `SELECT ... FOR UPDATE` tidak ada. Transaksi
   default `BEGIN` (deferred) punya celah baca-lalu-tulis yang bisa kehilangan update.

## Keputusan

### 1. Codec eksplisit, bukan Drizzle `customType`

`customType` sempat dipakai dan **dibuang**: ia butuh impor runtime core di
`schema.ts`, yang mematikan drizzle-kit (poin 1). Sebagai gantinya `schema.ts` hanya
memakai `import type` dari core, dan konversi terjadi di `db/decimal-codec.ts` pada
batas repository — persis yang diminta requirement ("conversion must happen at
repository boundaries").

Dua kelas representasi, keduanya TEXT:

| Kelas | Fungsi | Skala | Dipakai untuk |
|---|---|---|---|
| Uang | `encodeMoney` / `decodeMoney` | **8 dp tetap** (kanonik) | saldo, margin, PnL, fee, funding, amount |
| Non-uang | `encodeDecimalString` | nilai eksak, tanpa pembulatan | harga, rate, spesifikasi kontrak |

Alasan 8 dp untuk uang: itu skala kanonik yang sudah dikunci `ACCOUNTING.md` §1, dan
membuat nilai tersimpan deterministik (bisa dibandingkan sebagai string).
Alasan eksak untuk harga: memaksa 8 dp akan merusak `order_price_round` 11 dp milik
kontrak seperti SATS_USDT.

`encodeDecimalString` menolak notasi eksponen secara eksplisit, alih-alih diam-diam
menyimpannya (bisa mengubah arti string desimal).

### 2. Transaksi `BEGIN IMMEDIATE`

`connection.transaction()` memakai `sqlite.transaction(fn).immediate()` → `BEGIN
IMMEDIATE`, yang mengambil write-lock sejak awal transaksi. Ini pengganti yang benar
untuk `SELECT FOR UPDATE`: tidak ada celah antara membaca saldo dan menulisnya,
sehingga dua penulis tidak bisa saling menimpa. `busy_timeout` menangani penantian.
Diuji di `tests/phase1-ledger.test.ts` (test 12).

### 3. Ledger append-only ditegakkan database

Migrasi `0001_ledger_append_only.sql` memasang trigger `BEFORE UPDATE` / `BEFORE
DELETE` pada `ledger` **dan** `market_events` yang `RAISE(ABORT, ...)`. Jadi
immutability tidak bergantung pada disiplin repository: `UPDATE`/`DELETE` gagal walau
dijalankan dari luar aplikasi. Koreksi = entri `adjustment` baru.

### 4. Refinement DATA-MODEL: `margin_delta` / `reserved_delta` jadi kolom

`DATA-MODEL.md` awalnya menyimpan pergerakan margin di `meta_json.marginDelta`.
Diubah menjadi kolom eksplisit karena rebuild saldo **tidak boleh** bergantung pada
parsing JSON. Invariant "wallet_balance = Σ amount" tetap terjaga: tipe `margin_*`
wajib `amount = 0` (divalidasi di repository), sehingga margin tidak pernah menyentuh
wallet.

### 5. `fills.order_id` nullable

Fill likuidasi tidak berasal dari order. Tidak ada order sintetis yang dibuat hanya
agar kolom NOT NULL terpenuhi.

### 6. Semantik tanda `fees_paid` / `funding_paid`

Keduanya adalah **biaya kumulatif**, positif = trader membayar, dihitung sebagai
`-Σ amount` untuk tipenya. Karena `maker_fee_rate` selalu negatif, rebate membuat
`fees_paid` turun dan bisa negatif (artinya trader menerima). Ini menjaga makna kata
"paid" sekaligus menangani rebate tanpa kasus khusus.

### 7. Konvensi waktu & ID

- **Waktu**: epoch **milidetik** INTEGER, konsisten dengan `time_ms` Gate.io.
  Pengecualian: candle memakai **detik** (`candles.t`), mengikuti Gate.io yang memakai
  detik untuk open time candle.
- **ID domain**: TEXT, UUID v4 (`crypto.randomUUID`) dibuat repository.
- **Urutan log**: INTEGER PRIMARY KEY AUTOINCREMENT (`ledger.seq`, `order_events.seq`,
  `position_events.seq`, `market_events.seq`). `seq` memberi urutan total deterministik
  — inilah yang membuat replay punya urutan kronologis yang stabil, bukan timestamp.

## Konsekuensi

- `schema.ts` **wajib** hanya memakai `import type` dari core. Ditegakkan
  `tests/phase1-boundaries.test.ts`. Melanggarnya akan mematikan `bun run db:generate`.
- Konversi uang ada di satu tempat (`decimal-codec.ts`). Ditegakkan test yang menolak
  `toFixed`, `parseFloat`, `Number(`, `toNumber()` di `apps/server`.
- Query agregasi uang dilakukan di aplikasi (`Decimal`), bukan `SUM()` SQL — SQLite
  akan mem-float-kan teks.
- `BEGIN IMMEDIATE` menyerialkan penulisan. Diterima: paper trading single-user, write
  rendah, dan ingest pasar dibatch.
- Migrasi kustom tidak boleh diawali blok komentar sebelum penanda
  `--> statement-breakpoint` pertama: drizzle mengeksekusi tiap potongan sebagai satu
  statement, dan potongan berisi komentar saja akan gagal.
- `GET /api/health/integrity` dari `PLAN.md` Phase 1 belum dibuat karena HTTP baru ada
  di Phase 5. Sebagai gantinya `integrityReport()` + CLI `bun run db:migrate` sudah
  melaporkan integritas saat boot.

## Verifikasi

- `bun test` → 79 pass (43 Phase 0 + 36 Phase 1).
- `bun run check` → core build, adapters check, server check hijau.
- `bun run db:migrate` dua kali pada DB kosong → 15 tabel, 2 migrasi, idempoten.
- `PRAGMA journal_mode` = `wal`; trigger append-only terpasang; tidak ada kolom
  finansial bertipe REAL/NUMERIC (hanya `__drizzle_migrations.created_at` milik
  drizzle-kit sendiri).
