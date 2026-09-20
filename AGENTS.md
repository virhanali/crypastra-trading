# Aturan repo — crypastra-trading

Paper-trading crypto USDT perpetual futures. Uang virtual saja.

## Batas keras

- **Tidak ada eksekusi order ke exchange asli.** Tidak ada private trading API.
- **Uang bukan `number`.** Pakai `Decimal` dari `packages/core`. Dilarang `parseFloat`,
  `Number(uang)`, dan kolom DB bertipe `real`/`numeric` untuk uang.
- **`packages/core` tidak boleh import I/O** (fastify, drizzle, bun:sqlite, ws) dan
  tidak boleh menyebut vendor (`gateio`, `wss://`). Ditegakkan `tests/architecture.test.ts`.
- **`Date.now()` dan `Math.random()` dilarang di core** kecuali di definisi `Clock`.
  Semua jalur waktu disuntik agar replay deterministik.
- **Paper Exchange tidak tahu asal order.** Tidak ada field yang mengubah perilaku
  berdasarkan `human`/`jev`/`strategy`/`replay`/`test`. `source` hanya untuk audit.
- **Jev tidak diimplementasikan** sampai Phase 9, dan tidak pernah memegang ledger,
  order, leverage, atau saldo.

## Verifikasi wajib sebelum lapor

```bash
bun test        # semua hijau
bun run check   # build core + typecheck adapters
```

Untuk perubahan yang menyentuh parsing data pasar, jalankan juga `bun run probe`
(verifikasi live ke Gate.io). Sertakan output nyata, bukan klaim.

Perubahan akuntansi (margin, PnL, fee, funding, likuidasi) = risiko tinggi:
sertakan bukti before/after dan tambahkan test untuk setiap edge case baru.

## Fakta pasar yang sudah dikunci

Jangan "perbaiki" tanpa verifikasi ulang terhadap `docs/gateio-market-data.md`:

- Mark price **tidak** punya channel WS (`futures.mark_price` ditolak).
- Nama candle `"<interval>_<contract>"` — split hanya pada `_` pertama.
- `trades.size` bertanda; negatif = taker sell.
- `candlesticks.w` = window sudah tertutup.
- `quanto_multiplier` heterogen antar kontrak — jangan hardcode 0.0001.
- `maker_fee_rate` bisa negatif (rebate).

## Konvensi

- Bun workspace: `packages/*`, `apps/*`. Paket private `@crypastra/*`.
- `core` hanya bergantung pada `decimal.js` dan `zod`.
- Skema zod di `core`; parsing wire ada di `adapters`.
- Drizzle + `bun:sqlite` (WAL, `foreign_keys=ON`, `busy_timeout`) mengikuti pola piastra.
- ADR baru: `docs/decisions/NNNN-judul.md`. Bahasa Indonesia, tanpa basa-basi.
