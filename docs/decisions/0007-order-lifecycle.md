# 0007 — Siklus hidup order persisten: state machine, reservasi, idempotensi perintah

- Status: diterima
- Tanggal: 2026-09-20
- Melanjutkan: 0004 (batas domain), 0005 (persistensi), 0006 (kernel matematika)

## Konteks

Phase 3 menyambungkan kernel matematika murni (Phase 2) ke persistensi (Phase 1)
menjadi siklus order yang lengkap: submit → validasi → reservasi → match → fill →
posisi → fee → PnL → ledger → audit. Requirement eksplisit yang membentuk keputusan:

1. Paper Exchange harus tetap ORIGIN-AGNOSTIC; `OrderIntent` tidak boleh punya
   field asal.
2. Idempotensi harus di tingkat PERINTAH, bukan hanya per entri ledger.
3. Semua efek ekonomi satu perintah harus atomik.
4. Tidak ada repository dengan `update()` generik untuk state finansial.

## Keputusan

### 1. Idempotensi perintah lewat tabel `trade_commands`

Ledger sudah idempoten per entri, tapi satu perintah menghasilkan BANYAK efek
(reservasi, N fill, fee, PnL, posisi). Menambahkan kolom kunci di `orders` tidak
cukup karena perintah bisa menghasilkan beberapa fill.

Tabel `trade_commands (command_id PK, kind, account_id, order_id, created_at)`:
perintah pertama mengklaim baris; retry mendapat pelanggaran PRIMARY KEY (atau
membaca baris yang ada) dan mengembalikan hasil lama tanpa menjalankan efek apa pun.
`order_id` diikat sejak awal untuk perintah evaluate/cancel supaya hasil dapat
direkonstruksi dari database, bukan dari JSON hasil yang bisa menyimpang.

Konsekuensi: idempotensi berlaku di dalam transaksi `BEGIN IMMEDIATE`, jadi dua
retry paralel tidak bisa dua-duanya lolos.

### 2. State machine order eksplisit

Transisi dikunci di `packages/core/src/exchange/order-state.ts`. Transisi ilegal
melempar `InvalidOrderError`; tidak ada perbaikan diam-diam. Setiap perubahan status
menulis `order_events`.

```
created → validated → { open | partially_filled | filled | cancelled | rejected }
open → partially_filled → { partially_filled | filled | cancelled | expired }
filled | cancelled | rejected | expired = terminal
```

**Koreksi penting (bug ditemukan di Phase 3):** `statusAfterExecution` semula
mengembalikan `cancelled` untuk order yang tidak terisi. Untuk order RESTING itu
salah: evaluasi snapshot yang tidak menyentuh order akan membatalkannya, sementara
reservasi marginnya masih tertahan → `account_balances.reserved_margin` menyimpang
dari Σ reservasi order live. Sekarang resting tanpa fill tetap `open`. Ada regresi
di `tests/phase3-order-state.test.ts` dan invariant-nya diperiksa di skenario 1200
operasi.

`partially_filled` bersifat terminal untuk order immediate (sisa dibatalkan) dan
live untuk limit gtc/post_only. Liveness ditentukan `isOrderLive(type, tif, status)`,
bukan status saja.

### 3. Siklus reservasi

```
limit non-marketable : reserve ceil8(notional_limit / leverage)   → reserved_margin
fill                 : konversi porsi reservasi → margin posisi
cancel / sisa IOC    : lepas sisa reservasi
```

Konversi reservasi → margin posisi ditulis sebagai SATU entri ledger:
`margin_release` dengan `reservedDelta = −R_f` dan `marginDelta = +required`.
`amount = 0`, sehingga wallet tidak tersentuh dan invariant `Σ amount = wallet_balance`
tetap terjaga. Efek pada available: `Δavailable = R_f − required`.

Porsi reservasi yang dikonsumsi proporsional terhadap sisa ukuran order, dan
SELURUHNYA saat fill menghabiskan sisa order. Ini menjamin `orders.reserved_margin`
selalu cocok dengan Σ reservasi live.

Order market dan limit marketable TIDAK menahan reservasi (langsung taker), sesuai
`ACCOUNTING.md` §8. Keterjangkauannya diperiksa oleh risk gate (§5 di bawah).

### 4. Risk gate sebelum efek ekonomi

Margin baru dihitung lewat DRY RUN seluruh rencana fill sebelum menyentuh database.
Bila `netNewMargin > available`, order menjadi `rejected` tanpa satu pun efek
ekonomi. Ini juga menutup celah order market, yang tidak punya reservasi untuk
diperiksa.

### 5. Origin-agnostic tetap dijaga

`OrderIntent` TIDAK diberi field asal (`OrderIntentSchema` tetap `.strict()`, dan
test membuktikan field asal ditolak). Label produsen hidup sebagai `auditSource`
opsional pada PERINTAH SERVICE — di luar `OrderIntent` — dan hanya ditulis ke
`orders.source` untuk observability. Logika ekonomi tidak pernah membacanya.
`tests/phase3-origin-agnostic.test.ts` menjalankan skenario penuh untuk
manual/strategy/jev/replay dan membandingkan seluruh hasil ekonomi.

### 6. Repository dengan mutasi spesifik domain

Tidak ada `update()` generik. Mutasi finansial hanya lewat metode bernama:
`OrderRepository.setStatus/recordFill/setReservedMargin`,
`PositionRepository.create/applyIncrease/applyReduce/applyClose`,
`FillRepository.append`. `PositionRepository` menolak mutasi pada posisi non-open,
menolak pelepasan margin melebihi margin posisi, dan menolak increase yang tidak
menambah ukuran.

### 7. Flip = close + open baris baru

Sesuai invariant 6 `DATA-MODEL.md`. Posisi lama `closed` dengan `closeReason='flip'`,
posisi baru dibuka. Ukuran posisi tidak pernah negatif.

### 8. Pelepasan margin proporsional dibulatkan KE BAWAH

`roundMarginReleaseDown` (FLOOR 8 dp): margin yang dilepas tidak pernah melebihi
porsi proporsionalnya, jadi `used_margin` tidak turun di bawah nilai seharusnya.
Sisa pembulatan tetap terkunci sampai posisi ditutup penuh, di mana seluruh margin
sisa dilepas. Ini menjaga konservasi: `reserve → fill → cancel` tidak menciptakan
atau menghilangkan uang.

## Konsekuensi

- Satu perintah = satu transaksi `BEGIN IMMEDIATE`; kegagalan di titik mana pun
  (termasuk setelah fill dan mutasi posisi) menggulung order, fill, posisi, event,
  ledger, cache saldo, dan baris command.
- Order yang DITOLAK tetap dipersist untuk audit (status `rejected` + `reject_reason`
  + event `rejected`), tetapi tidak menghasilkan efek ekonomi apa pun. Keputusan ini
  mengikuti model `DATA-MODEL.md` yang sudah memuat status `rejected`.
- Migrasi `0003_trade_commands` hanya `CREATE TABLE`, jadi aman untuk DB yang sudah
  terisi.
- Catatan operasional migrasi: migrator Drizzle menerapkan migrasi yang `when`-nya
  lebih besar dari yang terakhir diterapkan. Jangan menambahkan migrasi dengan
  timestamp lebih lama dari yang sudah ada, atau ia akan dilewati. Test upgrade
  Phase 2 diperbarui untuk mencerminkan ini (membuang SEMUA migrasi setelah 0001,
  bukan hanya 0002).

## Verifikasi

- `bun test` → 325 pass (215 Phase 0–2 tanpa perubahan + 110 Phase 3), 0 fail.
- `bun run check` → core build, adapters check, server check hijau.
- Pemindaian unused/dead-code bersih untuk core dan server.
- `bun run db:migrate` dua kali pada DB kosong → 4 migrasi, 16 tabel, idempoten.
- Tidak ada kolom finansial bertipe REAL/NUMERIC.
