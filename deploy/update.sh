#!/usr/bin/env bash
# Pasang versi baru crypastra-recorder, lalu BUKTIKAN ia merekam.
# Pola rumah (cadence/selisik update.sh), disesuaikan: recorder tidak punya
# endpoint HTTP, jadi smoke test memakai healthcheck Docker + hitungan
# observasi yang bertambah — bukan curl.
#
# Dipanggil CI:  CRYPASTRA_IMAGE=ghcr.io/owner/repo:<sha> ./deploy/update.sh
# Manual:        ./deploy/update.sh                    (pakai image compose)
#
# Urutan aman (bagian K): migrasi TERPISAH dulu; gagal migrasi = berhenti,
# compose TIDAK di-restart, versi lama tetap jalan.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
COMPOSE="docker compose"
SERVICE=crypastra-recorder
TIMEOUT="${CRYPASTRA_SMOKE_TIMEOUT:-180}"
VOLUME="${CRYPASTRA_VOLUME:-crypastra-data}"

# Substitusi ${VAR} di compose.yaml membaca SHELL env, bukan env_file.
# Export dulu dari file env produksi agar CRYPASTRA_CONTRACTS /
# CRYPASTRA_RECORDING_POLICY / CRYPASTRA_JEV ikut ke interpolasi.
if [[ -f ../config/crypastra.env ]]; then
    set -a
    # shellcheck disable=SC1091
    source ../config/crypastra.env
    set +a
fi

log() { echo "[$(date +%H:%M:%S)] $*"; }

PREVIOUS="$($COMPOSE ps -q "$SERVICE" 2>/dev/null | head -1 | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)"
[[ -n "$PREVIOUS" ]] && log "versi berjalan: $PREVIOUS" || log "belum ada container berjalan"

# ── 1. Tarik image baru dulu (migrasi di bawah memakai image ini,
#    bukan build lokal — bangun image di VPS 2-core lambat 15 menit). ─────
log "menarik ${CRYPASTRA_IMAGE:-image dari compose}"
$COMPOSE pull "$SERVICE"

# ── 2. Migrasi dulu, sebelum menyentuh service yang jalan ────────────────
# Catatan: `compose run` TIDAK punya flag --no-build dan tidak membangun
# ulang bila image sudah ada lokal (sudah di-pull di langkah 1) — jangan
# ditambahi flag itu (pernah membuat migrasi gagal instan).
log "menjalankan migrasi (image baru, container sekali-pakai)"
if ! $COMPOSE run --rm --no-deps \
    -e CRYPASTRA_DB_PATH=/data/research.db \
    -e CRYPASTRA_MIGRATIONS_DIR=/app/apps/server/drizzle \
    "$SERVICE" bun run apps/server/src/db/migrate.ts; then
    log "GAGAL: migrasi gagal. Service TIDAK di-restart; versi lama tetap berjalan."
    $COMPOSE logs --tail=20 "$SERVICE" 2>/dev/null || true
    exit 1
fi
log "migrasi OK"

# Migrasi satu-kali dari era tarball-deploy: container lama bernama
# `app-crypastra-recorder-1` (project compose lama `app`) TIDAK dikelola
# project `crypastra` ini — tanpa baris ini dua recorder jalan bareng
# menulis ke volume DB yang sama. Aman diulang: tidak ada -> tidak apa-apa.
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'app-crypastra-recorder-1'; then
    log "menghentikan container legacy app-crypastra-recorder-1 (era pre-CI)"
    docker stop app-crypastra-recorder-1 >/dev/null 2>&1 || true
    docker rm app-crypastra-recorder-1 >/dev/null 2>&1 || true
fi

log "menjalankan versi baru"
$COMPOSE up -d --no-build "$SERVICE"

# ── 3. Smoke: sehat + observasi bertambah ────────────────────────────────
container_id() { $COMPOSE ps -q "$SERVICE" 2>/dev/null; }

log "smoke test: health + observasi bertambah (maks ${TIMEOUT}s)"
# max(seq) global, bukan count(*): O(log n) lewat indeks, bukan full scan.
# count(*) di DB jutaan baris butuh bermenit-menit di disk lambat dan
# menyaingi recorder yang sedang menulis.
count_obs() {
    docker run --rm -v "${VOLUME}:/data" --entrypoint bun \
        "${CRYPASTRA_IMAGE:-$($COMPOSE ps -q "$SERVICE" | head -1 | xargs -r docker inspect -f '{{.Config.Image}}')}" \
        -e "import {Database} from 'bun:sqlite'; const db = new Database('/data/research.db', {readonly: true}); const r = db.query(\"SELECT coalesce(max(seq),0) as n FROM market_observations\").get(); console.log(r.n);" \
        2>/dev/null || echo 0
}

mulai=$(date +%s)
while (( $(date +%s) - mulai < TIMEOUT )); do
    cid="$(container_id)"
    if [[ -n "$cid" ]]; then
        health="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
        if [[ "$health" == "healthy" ]]; then
            before="$(count_obs)"
            sleep 20
            after="$(count_obs)"
            if (( after > before )); then
                log "MENJAWAB: healthy, observasi ${before} -> ${after}. Deploy selesai."
                docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true
                exit 0
            fi
            log "healthy tapi observasi stagnan (${before} -> ${after}); tunggu..."
        fi
    fi
    sleep 10
done

log "GAGAL: versi baru tidak sehat/merekam dalam ${TIMEOUT}s."
$COMPOSE logs --tail=40 "$SERVICE" || true
[[ -n "$PREVIOUS" ]] && log "kembalikan manual: CRYPASTRA_IMAGE=\"$PREVIOUS\" $COMPOSE up -d --no-build $SERVICE"
exit 1
