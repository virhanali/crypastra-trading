# 0011 — Rekaman observasi ternormalisasi & replay deterministik

- Status: diterima
- Tanggal: 2026-09-20
- Melanjutkan: 0009 (outbox/realtime), 0010 (runtime pasar live)

## Konteks

Phase 8 membangun infrastruktur rekam/putar-ulang. Requirement yang membentuk
keputusan:

- Replay harus masuk lewat batas market-data yang SUDAH ADA; satu mesin ekonomi.
- Rekaman harus cukup untuk mereproduksi mark, TP/SL, likuidasi, funding, dan
  kutipan eksekusi — candle tertutup saja tidak cukup.
- Urutan replay harus total dan deterministik.
- Replay tidak boleh menyentuh akun paper LIVE.
- Rekamannya harus mandiri (self-contained), bukan merekonstruksi dari API hari ini.

## Keputusan

### 1. Observasi ternormalisasi sebagai satu-satunya bentuk tersimpan

Empat jenis: `mark`, `quote`, `funding`, `candle`. Payload mentah Gate TIDAK
disimpan, dan replay tidak mem-parse ulang payload Gate. Pemetaan dua arah
(`observationsFromEvent` ↔ `observationToEvents`) ada di core dan dipakai jalur
live maupun replay, sehingga tidak ada "parser A untuk live, parser B untuk replay".

Konsekuensi penting yang ditemukan saat implementasi: `observedAtMs` diisi jam
**lokal** penerimaan, bukan jam exchange. Waktu exchange antar kanal
(`futures.tickers` vs `futures.book_ticker`) saling mendahului, sehingga memakai
jam exchange sebagai `observedAtMs` membuat VirtualClock mundur. Jam exchange tetap
tersimpan sebagai `sourceTimestampMs`, dan staleness dihitung dari selisih keduanya
— persis seperti live.

### 2. Dua kelas data

`mark`/`quote`/`funding` = **ekonomi** (determinan perilaku exchange).
`candle` = **analitik** (untuk indikator/strategy/scanner nanti).

Harga close candle bukan pengganti mark maupun kutipan yang dapat dieksekusi.

### 3. Observasi funding membawa mark

`funding` menyimpan `fundingRate`, `fundingTimestampMs`, `intervalSeconds`, DAN
`markPrice`. Alasannya `MarkToMarketService` menghitung funding dari notional pada
mark; tanpa mark tersimpan, rekaman tidak mandiri.

### 4. Kebijakan volume per jenis

- `mark` selalu ditulis (ticker murah, dan staleness replay harus identik dengan
  live — mark bernilai sama tetap memperbarui waktu).
- `quote`/`funding` hanya saat nilainya berubah.
- `candle` hanya yang tertutup.
- Depth TIDAK direkam: eksekusi live memakai puncak buku.

Ukuran terukur (25 detik BTC_USDT): 554 observasi, 22.5/detik, ~14 MiB/jam,
~332 MiB/24 jam, dengan `quote` mendominasi ~96%. Ini dicatat sebagai masukan
sebelum pengumpulan dataset strategy, bukan untuk dioptimasi sekarang.

### 5. Urutan = `seq`, bukan timestamp

`market_observations.seq` (AUTOINCREMENT) adalah urutan total kanonik. Timestamp
antar kanal dapat bertabrakan atau tidak monoton.

Bila rekaman tidak monoton waktu, VirtualClock di-clamp ke nilai tertinggi
sementara observasi tetap diproses pada urutan `seq`. Perilaku ini eksplisit
(dokumentasi + test), bukan perbaikan diam-diam.

### 6. Isolasi dua koneksi

`ReplayService` menerima `source` (database rekaman, dibaca saja) dan `target`
(database terisolasi, semua tulisan ekonomi). Ini koreksi desain yang dipicu smoke
test: rekaman pasar bukan keadaan akun, jadi tidak perlu disalin — yang diisolasi
adalah ekonominya. Akun LIVE tidak pernah tersentuh.

### 7. ID deterministik di jalur ekonomi replay

Replay menyuntikkan pabrik id deterministik ke `OrderService` (order/fill/posisi)
dan id perintah `replay:{sessionId}:{index}`. Tidak ada UUID acak di jalur ekonomi
replay, sehingga id dapat direproduksi.

### 8. Hashing kanonik mengecualikan identitas internal

`idempotencyKey` ledger **dikecualikan** dari sidik jari karena mengandung UUID
akun/fill — identitas internal, bukan keadaan ekonomi (§23 requirement). Yang
disertakan: tipe, nilai, margin/reserved delta, balanceAfter, refType, harga,
ukuran, status. Baris diurutkan berdasarkan isi.

Ini sidik jari determinisme (FNV-1a 64-bit), bukan hash kriptografis, dan klaimnya
"ekuivalen secara kanonik", bukan "database identik byte-per-byte".

### 9. `Ticker.fundingRate` menjadi nullable

Ditemukan saat implementasi: `fundingRate` bertipe non-null, sehingga adapter
mengisi `"0"` ketika field exchange tidak ada — melanggar prinsip Phase 6 sendiri
("jangan mengarang nilai finansial"). Sekarang nullable, dan mark kosong/spasi
diperlakukan sebagai tidak ada (tidak menghasilkan observasi mark).

### 10. `LiveRiskProcessor` → `MarketRiskProcessor`

Kelas itu tidak pernah bergantung pada sumber data, jadi namanya menyesatkan.
Di-rename; alias `LiveRiskProcessor` dipertahankan agar pemanggil lama tidak putus.
Live dan replay memakai instance yang sama — tidak ada risk engine kedua.

## Konsekuensi

- Migrasi `0006` (dua tabel) + `0007` (trigger append-only).
- Perilaku saat perekaman MATI tidak berubah: hanya candle tertutup yang disimpan.
- `bun run smoke:live-api` tetap sah (tidak ada perubahan jalur live).
- Replay berjalan sinkron di proses yang sama; belum ada worker terpisah.
- Depth penuh tidak direkam, jadi eksekusi replay setara puncak buku.

## Verifikasi

- `bun test` → 660 pass (631 sebelumnya + 29 Phase 8), 0 fail.
- `bun run check` → core, adapters, server, web semua hijau (svelte-check 0 error).
- `vite build` → bersih.
- `bun run smoke:record-replay` (live, 25 dtk, `SMOKE_TRADE=1`): 554 observasi,
  dua putaran replay menghasilkan hash gabungan **identik** (`9f9931226c1d2785`)
  dan wallet identik (`999.99390590`).
