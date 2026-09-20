# 0001 — Fondasi runtime: Bun monorepo + TypeScript + SQLite/Drizzle

- Status: diterima
- Tanggal: 2026-09-20

## Konteks

Repo `/home/esb/project/crypastra-trading` **kosong** (tanpa git, tanpa file) saat
inspeksi pertama. Tidak ada
teknologi existing yang perlu dipertahankan, tapi ada konvensi rumah yang jelas di
repo saudara `/home/esb/project/piastra` (Bun 1.4.0 monorepo, workspace
`apps/*` + `packages/*`, Fastify + Drizzle + `bun:sqlite`, Svelte 5 + Vite +
Tailwind 4, core murni ber-zod, adapters terpisah). `selisik` memakai Python/Streamlit,
`cadence` memakai Bun + Hono + Svelte.

Environment: Bun 1.4.0, Node 22.23.2, Go 1.27, Python 3.12 + uv, Docker 29.8 +
Compose v5.5.1. Tidak ada PostgreSQL, Redis, atau sqlite3 CLI terpasang.

## Keputusan

Pakai **Bun 1.4.0 sebagai runtime + package manager**, **TypeScript** (mengikuti
versi piastra, `typescript@5.9.3`, bukan TS 7 yang masih terlalu baru untuk ekosistem
ini), **SQLite via `bun:sqlite` + Drizzle ORM**, monorepo workspace
`packages/*` + `apps/*`.

Alasan:
1. **Konsistensi rumah.** Pola piastra sudah terbukti: `packages/core` murni,
   `packages/adapters` untuk I/O, `apps/server` untuk HTTP/DB, `apps/web` untuk UI.
   Pemisahan domain yang diminta user (market data / state / strategy / decision /
   exchange) memetakan hampir 1:1 ke bentuk ini.
2. **Bun menghilangkan friksi.** `bun test` built-in (tidak perlu memasang Vitest),
   `bun:sqlite` built-in (tidak perlu `better-sqlite3` yang butuh native build, dan
   tidak ada sqlite3 CLI di environment), TS dieksekusi langsung tanpa build step di
   dev.
3. **SQLite cukup untuk paper trading single-user.** Satu akun, satu proses, write
   ter-batch (pola `EventBus` piastra). WAL + `busy_timeout` memberi durability yang
   memadai. Ledger append-only dengan volume rendah (bukan HFT).
4. **Fastify** (bukan Hono) mengikuti piastra: ekosistem zod + plugin lebih matang,
   dan pola `app.ts` piastra bisa ditiru langsung.
5. **Docker** tersedia (Compose v5.5.1) untuk deployment nanti; SQLite disimpan di
   volume.

## Konsekuensi

- Tidak ada Postgres → tidak ada `NUMERIC`/`DECIMAL` asli. Semua uang disimpan sebagai
  `text` (lihat ADR 0002). Ini justru memperkuat disiplin anti-float.
- `apps/web` memakai Svelte 5 (bukan React). Mengikuti `cadence`, bukan pilihan
  netral — charting realtime lebih ringan di Svelte, dan tidak ada kode existing yang
  memaksa React.
- SQLite single-writer: ingest pasar dan eksekusi order harus lewat antrian dalam satu
  proses. Diterima — paper trading tidak butuh multi-node.
- Git belum diinisialisasi di repo ini. Perlu `git init` sebelum PR pertama.

## Alternatif yang ditolak

- **Node + npm + Postgres.** Lebih berat untuk single-user paper trading, tidak ada
  DB terpasang di environment, dan kehilangan `bun test`/`bun:sqlite`.
- **Python/uv + FastAPI (mengikuti selisik).** Bagus untuk analitik, tapi charting
  realtime di browser dan numeric discipline lebih mudah dijaga di TS dengan
  decimal.js. Selisik juga bukan terminal realtime.
- **Go (mengikuti px0-git / go-core-api).** Performa bagus, tapi UI terminal dan
  iterasi cepat lebih lambat, dan ekosistem desimalnya kurang nyaman.

## Verifikasi

- `bun --version` → `1.4.0`; `node -v` → `v22.23.2`.
- `packages/core`, `packages/adapters` mengikuti bentuk piastra (`exports` dist, zod
  only di core).