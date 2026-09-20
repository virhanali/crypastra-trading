# 0004 — Pemisahan domain: MarketDataProvider, MarketState, PaperExchange

- Status: diterima
- Tanggal: 2026-09-20

## Konteks

Permintaan user menyatakan rantai domain yang harus terpisah:

```
Market Data → Market State → Strategy/Feature → Jev → Decision/Risk → Paper Exchange
```

dan Paper Exchange "must NOT know whether an order came from a human, Jev, an
automated strategy, replay, or tests. It only accepts validated paper orders."

Repo kosong tapi ada konvensi rumah (piastra: `packages/core` murni ber-zod,
`packages/adapters` untuk I/O). Pemisahan yang diminta harus ditegakkan **secara
mekanis**, bukan hanya kesepakatan — kalau tidak, batas akan bocor pada implementasi
pertama yang terburu-buru.

## Keputusan

1. Empat paket dengan aturan import yang dapat diverifikasi:

| Paket | Isi | Boleh import |
|---|---|---|
| `@crypastra/core` | money, tipe domain, skema zod, matematika exchange murni, MarketState, interface provider | `decimal.js`, `zod` |
| `@crypastra/adapters` | `GateioMarketDataProvider`, replay, sim | `@crypastra/core`, `ws` |
| `apps/server` | HTTP, DB, orkestrasi, matchmaking state | core, adapters, drizzle, fastify, bun:sqlite |
| `apps/web` | UI | core (tipe saja) |

2. **`MarketDataProvider`** adalah interface di core; Gate.io hidup hanya di
   `packages/adapters`. Core tidak pernah menyebut `gateio`, `wss://`, atau nama
   channel.

3. **MarketState** adalah objek pasif di core: `ticker`, `mark`, `index`, `topOfBook`,
   `candles`, `contract`, `nowMs`. Ia tidak menyimpan referensi ke provider dan tidak
   melakukan I/O.

4. **Paper Exchange tidak menerima `source`** sebagai input yang mengubah perilaku.
   `OrderIntent` tidak punya field `source`. Kolom `orders.source` hanya ada untuk
   **audit**, ditulis oleh lapisan pemanggil, dan **tidak dibaca** oleh logika
   matching/margin/likuidasi. Ada test yang membuktikan order identik dengan
   `source` berbeda menghasilkan fill/ledger identik.

5. **Jev tidak punya tipe akses tulis** ke ledger/order/position. `JevEvaluator`
   hanya mengembalikan `JevOutput { pTrend, pMomentum, pReversal, btcRegime,
   confidence, modelVersion }`. Tidak ada `leverage`, tidak ada `size`.

6. **Clock disuntik**, bukan global. `Clock { nowMs(): number }`. Core tidak pernah
   memanggil `Date.now()` atau `Math.random()`.

## Alasan

- Batas yang hanya dijaga oleh konvensi akan bocor. Batas yang dijaga oleh aturan
  import paket + tipe tidak bisa dilanggar tanpa mengubah `package.json`.
- Mengikuti pola `HarnessAdapter` di piastra (`packages/core/src/adapters.ts`),
  yang sudah membuktikan bahwa interface plugin di core + implementasi di adapters
  bekerja untuk beberapa backend berbeda (Claude, Pi, Codex, OpenCode).
- `source` sebagai audit-only adalah syarat eksplisit user. Mengizinkannya sebagai
  parameter perilaku akan melanggar "Paper Exchange must NOT know".

## Konsekuensi

- Lebih banyak file dan boilerplate di awal (interface di core, implementasi di
  adapters) dibanding menulis langsung di server. Diterima: ini satu-satunya cara
  memenuhi syarat "must not couple to Gate.io".
- Butuh test arsitektur: assert `packages/core/src/**` tidak memuat string `gateio`,
  `wss://`, `ws`, `fastify`, `drizzle`, `Date.now`, `Math.random`.
- Butuh test arsitektur: `@crypastra/core` package.json tidak memuat dependency I/O.
- Order yang datang dari replay tetap harus melewati validasi yang sama (tick, size,
  margin) — replay tidak mendapat "jalan pintas".

## Verifikasi

- Test `architecture.test.ts`: pemindaian source + `package.json` untuk larangan di atas.
- Test `origin-agnostic.test.ts`: dua `OrderIntent` identik kecuali `source` →
  `Fill` dan entri `ledger` identik.
- Test `provider-parity.test.ts`: dummy provider live-mode dan replay-mode
  menghasilkan `MarketEvent` dengan bentuk yang sama, dan engine mengonsumsi keduanya
  tanpa cabang `if (mode)`.