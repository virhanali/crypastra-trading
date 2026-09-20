# crypastra-trading

Paper-trading terminal untuk crypto USDT perpetual futures. **Uang virtual saja** —
tidak ada eksekusi order ke exchange asli, tidak ada private trading API.

> Catatan: direktori saudara `/home/esb/project/crypastra` adalah proyek video
> Remotion yang tidak berhubungan. Repo ini yang berisi platform trading.

Status: **fase 0 (fondasi & spesifikasi)**. Belum ada UI, belum ada Jev, belum ada
trading engine penuh. Lihat `docs/PLAN.md` untuk fase berikutnya.

## Dokumen

| Dokumen | Isi |
|---|---|
| `docs/PRODUCT.md` | requirement produk, arah visual, layout |
| `docs/ARCHITECTURE.md` | batas domain, aliran, prinsip |
| `docs/DATA-MODEL.md` | entitas, relasi, invariant |
| `docs/ACCOUNTING.md` | aturan uang, formula, edge case |
| `docs/PLAN.md` | fase, kriteria penerimaan, assumption |
| `docs/gateio-market-data.md` | fakta Gate.io terverifikasi + cara reproduksi |
| `docs/STATUS.md` | status terakhir |
| `docs/decisions/` | ADR |

## Struktur

```
packages/core       @crypastra/core       domain murni: money, contract, market,
                                          exchange math, ledger, MarketState
packages/adapters   @crypastra/adapters   Gate.io provider, sim provider, parser
apps/               (belum) server, web
tools/              probe untuk verifikasi Gate.io
tests/              test arsitektur + akuntansi
```

## Perintah

```bash
bun install
bun test          # 43 test
bun run check     # build core + typecheck adapters
bun run probe     # verifikasi live ke Gate.io (REST + WS), read-only
```

## Prinsip yang ditegakkan test

- Uang tidak pernah `number`/float. `decimal.js`, disimpan sebagai string.
- `packages/core` tidak menyebut vendor/I/O apa pun (tidak ada `gateio`, `wss://`,
  `fastify`, `drizzle`, `Date.now()` di jalur akuntansi).
- Paper Exchange tidak tahu asal order: order identik dari `human`/`jev`/`strategy`/
  `replay`/`test` menghasilkan fill dan ledger identik.

## Stack

Bun 1.4.0 · TypeScript 5.9 · decimal.js · zod 4 · WAL SQLite + Drizzle + Fastify
(phase 1) · Svelte 5 + Vite + Tailwind 4 (phase 7).
