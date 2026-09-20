# Recorder-only image: RECORD ONLY / RECORD + COLLECT (tools/record-market.ts).
# Tidak ada web, tidak ada fastify server — hanya core + adapters + db layer
# yang dipakai record-market.ts dan dataset-status.ts.
FROM oven/bun:1.4-slim AS deps

WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
# `web` workspace wajib ada di disk (root bun.lock menyebutnya) meski image
# ini tidak memakainya; package.json saja cukup, tidak perlu src/.
RUN bun install --frozen-lockfile --production
# @crypastra/core dan @crypastra/adapters adalah devDependency ROOT (dipakai
# tools/*.ts yang jalan dari repo root), jadi --production tidak membuat
# symlink workspace-nya. Buat manual — lebih ringan daripada full install
# (~60MB vs ~225MB, TypeScript & devDeps lain tidak ikut terbawa).
RUN mkdir -p node_modules/@crypastra \
    && ln -s ../../packages/core node_modules/@crypastra/core \
    && ln -s ../../packages/adapters node_modules/@crypastra/adapters

FROM oven/bun:1.4-slim AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile
COPY packages/core/ packages/core/
COPY packages/adapters/ packages/adapters/
RUN bun run --filter @crypastra/core build && bun run --filter @crypastra/adapters build

FROM oven/bun:1.4-slim AS runtime

ENV NODE_ENV=production
ENV TZ=UTC
RUN useradd --uid 10003 --create-home --shell /usr/sbin/nologin crypastra \
    && mkdir -p /data \
    && chown crypastra:crypastra /data
WORKDIR /app

# Dependensi produksi lebih dulu (lapisan stabil), kode belakangan.
# bun hoist SEBAGIAN paket ke node_modules root (symlink ke
# node_modules/.bun/<pkg>), tapi tiap workspace yang dipakai (packages/core,
# packages/adapters, apps/server) juga punya node_modules SENDIRI berisi
# symlink balik ke node_modules/.bun — keempatnya wajib disalin, bukan
# hanya root.
COPY --from=deps --chown=crypastra:crypastra /app/node_modules ./node_modules
COPY --from=deps --chown=crypastra:crypastra /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps --chown=crypastra:crypastra /app/packages/adapters/node_modules ./packages/adapters/node_modules
COPY --from=deps --chown=crypastra:crypastra /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=crypastra:crypastra /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=crypastra:crypastra /app/packages/adapters/dist ./packages/adapters/dist
COPY --chown=crypastra:crypastra packages/core/package.json packages/core/package.json
COPY --chown=crypastra:crypastra packages/adapters/package.json packages/adapters/package.json
COPY --chown=crypastra:crypastra apps/server/package.json apps/server/package.json
COPY --chown=crypastra:crypastra apps/server/src/ apps/server/src/
COPY --chown=crypastra:crypastra apps/server/drizzle/ apps/server/drizzle/
COPY --chown=crypastra:crypastra tools/ tools/
COPY --chown=crypastra:crypastra scripts/ scripts/

USER crypastra
VOLUME ["/data"]

# tools/record-market.ts dipanggil LANGSUNG (bukan lewat script
# "record:market" di package.json), karena script itu mengulang
# `bun run --filter @crypastra/core build` — TypeScript tidak ada di image
# runtime, dan dist core/adapters sudah dibangun di stage `build`. Migrasi
# DB tetap berjalan (openDatabase runMigrations default true) sebelum
# runtime pasar start; kegagalan migrasi melempar dan proses keluar
# non-zero sebelum ada koneksi Gate (lihat K).
#
# `bun run <file.ts>` meneruskan sinyal ke proses itu sendiri (bukan shell
# wrapper terpisah), jadi SIGTERM docker stop sampai ke handler shutdown di
# tools/record-market.ts tanpa PID 1 tambahan.
CMD ["bun", "run", "tools/record-market.ts"]
