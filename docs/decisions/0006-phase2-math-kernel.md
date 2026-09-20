# 0006 — Kernel matematika Phase 2: satuan, pembulatan, model likuidasi, `enable_decimal`

- Status: diterima
- Tanggal: 2026-09-20
- Melanjutkan: 0002 (decimal money), 0003 (mark price), 0005 (persistensi)

## Konteks

Phase 2 mengimplementasikan kernel matematika murni paper exchange. Tiga hal
ditemukan dari probe 997 kontrak USDT Gate.io (20 Sep 2026) yang membentuk
keputusan di sini:

1. **`enable_decimal` hilang dari `ContractSpec`.** 14 dari 997 kontrak bernilai
   `true` dengan `order_size_min = 0`, termasuk **ETH_USDT, SOL_USDT, XRP_USDT,
   TRX_USDT**. Akibatnya `validateSize` Phase 0 menolak ukuran desimal untuk
   kontrak yang justru mendukungnya, dan `size < orderSizeMin` dengan min 0
   meloloskan ukuran 0.
2. **`order_price_round` sampai 11 dp** (`SATS_USDT` = `0.00000000001`). Harga
   tidak boleh memakai skala uang 8 dp.
3. **`1/leverage_max − maintenance_rate > 0` di seluruh 997 kontrak** (minimum
   0.002; contoh ARIA_USDT: 1/10 − 0.08 = 0.02). Ini menentukan domain sah model
   likuidasi.

Selain itu ditemukan satu bug nyata di kode matching Phase 0 (lihat §5).

## Keputusan

### 1. Satuan ditulis eksplisit di setiap rumus

```
contracts × base_asset_per_contract = base_asset_quantity
base_asset_quantity × quote_per_base  = quote notional
quote notional × rate                 = quote fee/funding
```

`quanto_multiplier` = base asset per 1 contract dan heterogen (0.0001 BTC,
0.01 ETH, 1 SOL, 10 XRP, 100 ARIA, 10 000 000 PEPE/SATS). Tidak ada asumsi BTC
global; setiap fungsi membaca spesifikasi kontrak.

### 2. `enable_decimal` ditambahkan ke `ContractSpec` (koreksi Phase 0)

Field `enableDecimal: boolean` ditambahkan dengan `default(false)` supaya
konstruksi lama tetap sah. `assertValidSize` sekarang:
- menolak `size <= 0` **selalu** (min 0 tidak berarti ukuran 0 sah),
- menolak desimal bila `enableDecimal === false`,
- menerima desimal bila `true`.

Kolom `contracts.enable_decimal` ditambahkan lewat migrasi `0002` dengan
`DEFAULT 0`. **Default wajib**: SQLite menolak `ADD COLUMN ... NOT NULL` tanpa
default pada tabel berisi baris, jadi tanpa default migrasi akan gagal pada
database Phase 1 yang sudah terisi. Ada test upgrade nyata
(`tests/phase2-persistence-upgrade.test.ts`).

### 3. Pembulatan dipusatkan di `exchange/rounding.ts`

Modul exchange lain **dilarang** memakai `toDecimalPlaces`, `Decimal.ROUND_*`,
`.toNumber()`, `Number()`, `parseFloat`, `parseInt`. Ditegakkan test.

| Besaran | Fungsi | Arah | Alasan ekonomi |
|---|---|---|---|
| PnL, funding, rasio | `roundMoneyNeutral` | HALF_UP 8 dp | tidak bias pihak mana pun |
| Fee | `roundFeeAmount` | **CEIL** 8 dp | biaya naik, rebate mengecil — trader tidak pernah lebih baik dari eksak |
| Margin awal & maintenance | `roundMarginUp` | CEIL 8 dp | trader menaruh margin tidak kurang dari eksak |
| Available balance | `roundAvailableDown` | FLOOR 8 dp | trader tidak bisa membelanjakan melebihi tersedia |
| Harga | `quantizeToTick` | HALF_UP ke tick | grid harga kontrak, bisa 11 dp |
| Harga likuidasi | `quantizeLiquidationPrice` | CEIL (long) / FLOOR (short) ke tick mark | memicu likuidasi lebih awal |
| Rate | `scaleRate` | HALF_UP 18 dp | presisi representasi, bukan uang |
| Cacah kontrak | `floorToContractCount` | FLOOR 0 dp | `size` adalah cacah, bukan uang |

**Catatan penting soal fee.** Sempat terlihat seolah aturan Phase 0
("ROUND_UP pada nilai absolut") tidak konsisten untuk rebate. Setelah dihitung
ulang: `ROUND_CEIL` pada **amount bertanda** (positif = biaya) sudah benar untuk
kedua arah — biaya `+0.0000000375 → 0.00000004` (trader membayar lebih), rebate
`−0.000000805 → −0.00000080` (magnitudo mengecil, trader menerima lebih sedikit).
Yang salah adalah pembacaan "floor delta dompet", karena delta dompet bertanda
terbalik dari amount. Jadi **tidak ada perubahan perilaku** pada fee; yang
berubah hanya namanya (`roundFeeAmount`) dan dokumentasinya. Test dust fee Phase 0
tetap lulus tanpa diubah.

### 4. Likuidasi di belakang batas model

`LiquidationModel` + `SimpleIsolatedLiquidationModel` (dipakai default). Model
default menyatakan `provenance: "simulator"` secara eksplisit dan **tidak pernah**
disebut sebagai formula Gate.io (A6 belum terverifikasi).

```
initial_margin = ceil8(notional_entry / leverage)
maintenance    = ceil8(notional(mark) × maintenance_rate)
buffer         = initial_margin − maintenance_at_entry
distance/unit  = buffer / (size × quanto_multiplier)
liq_long       = entry − distance      ← kuantisasi ceil ke tick
liq_short      = entry + distance      ← kuantisasi floor ke tick
```

**Domain sah:** `buffer > 0`, yaitu `1/leverage > maintenance_rate`. Di luar itu
model mengembalikan hasil bertipe `{ kind: "no_price", reason:
"initial_margin_not_above_maintenance" }` — keadaan pasar yang sah tapi
degenerate, **bukan** input tidak valid dan **bukan** di-clamp ke 0. Pada domain
sah, harga likuidasi selalu > 0 dan selalu ada.

Konsekuensi: clamp lama `if (price <= 0) return 0` dihapus karena menyembunyikan
kasus degenerate. Yang tetap ada hanyalah clamp pada **settlement dompet**
(kerugian isolated tidak membuat saldo negatif) — itu memang aturan akuntansi.

Asumsi yang masih terbuka (A6): maintenance dihitung dari harga entry, bukan
harga likuidasi; fee taker penutup tidak masuk rumus; MMR tunggal bukan
berjenjang; funding tidak masuk rumus.

### 5. Bug `avgPrice` di matching Phase 0 (diperbaiki)

Phase 0 menghitung rata-rata harga fill sebagai
`Σ(harga × size × quanto_multiplier) / Σsize`, yang menghasilkan
`quanto_multiplier × harga` — untuk BTC_USDT `8.001`, bukan `80010`. Rata-rata
harga tidak boleh melibatkan `quanto_multiplier`. Diperbaiki menjadi rata-rata
tertimbang ukuran lalu dikuantisasi ke `order_price_round`, dengan regresi di
`tests/phase2-liquidation.test.ts` dan `tests/phase2-tpsl-matching.test.ts`.
Tidak ada test Phase 0 yang menguji `avgPrice`, jadi bug ini tidak tertangkap.

### 6. Koreksi klaim "gap" pada TP/SL

`ACCOUNTING.md` §7 sebelumnya menyebut SL diprioritaskan bila TP dan SL
"terpenuhi dalam satu tick (gap)". Itu keliru: untuk LONG, TP terpenuhi saat
`observed ≥ tp` dan SL saat `observed ≤ sl`, sehingga keduanya **saling
eksklusif** pada satu harga selama `tp > sl`. Keduanya hanya bisa terpenuhi
bersamaan bila harganya **bersilangan** (`tp ≤ sl` untuk long) — keadaan salah
konfigurasi. Prioritas SL tetap dipertahankan sebagai perilaku konservatif, tapi
alasannya didokumentasikan ulang.

## Konsekuensi

- Semua matematika exchange memakai pembulatan bernama; menambah pembulatan liar
  akan menggagalkan test.
- `ContractSpec` bertambah satu field; adapters mengisinya dari `enable_decimal`.
- PnL di bawah setengah satuan 8 dp dibulatkan ke 0. Untuk kontrak bertick sangat
  kecil (mis. ARIA) dibutuhkan ukuran posisi lebih besar agar PnL terwakili. Ini
  konsekuensi langsung dari skala uang 8 dp, bukan bug.
- `validateSize`/`validateLeverage` di `contract.ts` ditandai deprecated dan
  mendelegasikan ke `assertValidSize`/`assertValidLeverage`.

## Verifikasi

- `bun test` → 215 pass (79 Phase 0/1 + 136 Phase 2), 0 fail.
- `bun run check` → core build, adapters check, server check hijau.
- `bun run db:migrate` dua kali pada DB kosong → 15 tabel, 3 migrasi, idempoten.
- Upgrade DB Phase 1 berisi data → migrasi 0002 berhasil, baris lama utuh.
- `bun run probe` → REST + WS Gate.io hidup; candle & ticker normal.
- Tidak ada kolom finansial bertipe REAL/NUMERIC.
