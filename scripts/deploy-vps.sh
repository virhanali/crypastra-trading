#!/usr/bin/env bash
# Deploy crypastra-recorder ke VPS (bagian M).
#
#   ./scripts/deploy-vps.sh [vps-name]
#
# VPS ini HANYA terjangkau lewat `dalang` CLI (SSH langsung timeout — lihat
# docs/decisions atau catatan deploy). Jadi skrip ini memakai `dalang scp` +
# `dalang exec`, bukan ssh/scp mentah. `dalang exec` punya batas waktu ~30s
# per panggilan, jadi build/migrate/up dijalankan di VPS lewat `nohup ... &`
# ke file log, dipoll dari sini — bukan satu panggilan exec yang menunggu.
#
# Repo ini belum digit-init (lihat ADR 0001), jadi metode transfer adalah
# tarball sumber (bukan git pull), sesuai daftar opsi di bagian M task.
#
# TIDAK PERNAH menghapus /opt/crypastra/backups atau volume Docker
# crypastra-data. Deploy hanya mengganti isi /opt/crypastra/app/.
set -euo pipefail

VPS="${1:-kuonstudio}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_BASE="/opt/crypastra"
REMOTE_APP="${REMOTE_BASE}/app"
REMOTE_STAGING="${REMOTE_BASE}/.staging-app"
LOG_TAG="deploy-$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE_LOG="/tmp/crypastra-${LOG_TAG}.log"

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

dexec() { dalang exec "$VPS" "$@"; }

# `dalang exec` mengembalikan output tunggal per panggilan; untuk perintah
# panjang kita nohup ke background dan poll marker akhir, supaya tidak
# terpotong batas waktu ~30s command tunggal.
run_bg_and_wait() {
    local cmd="$1"
    local marker_ok="___DEPLOY_OK___"
    local marker_fail="___DEPLOY_FAIL___"
    # `& true` (bukan `&` polos) di akhir: dalang exec menambahkan
    # `; __exit_code=$?; echo` setelah string ini, dan `&;` adalah syntax
    # error di bash (perlu perintah setelah &). `& true` memberi token valid
    # untuk ditempeli titik koma pembungkus.
    dexec "nohup bash -c '${cmd} && echo ${marker_ok} >> ${REMOTE_LOG} || echo ${marker_fail} >> ${REMOTE_LOG}' > /dev/null 2>&1 & true"
    local waited=0
    local timeout="${2:-600}"
    while (( waited < timeout )); do
        sleep 5
        waited=$((waited + 5))
        local tail
        tail="$(dexec "tail -c 4000 ${REMOTE_LOG} 2>/dev/null")"
        if echo "$tail" | grep -q "$marker_ok"; then
            echo "$tail"
            return 0
        fi
        if echo "$tail" | grep -q "$marker_fail"; then
            echo "$tail" >&2
            return 1
        fi
    done
    echo "[deploy] TIMEOUT menunggu perintah selesai (>${timeout}s): $cmd" >&2
    return 1
}

# ── 1. Validasi state lokal ─────────────────────────────────────────────
log "validasi state lokal"
for f in Dockerfile compose.yaml .dockerignore package.json bun.lock; do
    [[ -f "$REPO_ROOT/$f" ]] || { echo "[deploy] GAGAL: $f tidak ada" >&2; exit 1; }
done
if [[ ! -f "$REPO_ROOT/config/crypastra.env.local" && -z "${CRYPASTRA_SKIP_ENV_CHECK:-}" ]]; then
    log "catatan: pastikan ${REMOTE_BASE}/config/crypastra.env sudah ada di VPS (tidak dibuat ulang oleh skrip ini)"
fi

# ── 2. Siapkan tarball sumber (set file yang sama dipakai Dockerfile) ───
log "membungkus source tarball"
TARBALL="$(mktemp /tmp/crypastra-src-XXXXXX.tar.gz)"
trap 'rm -f "$TARBALL"' EXIT
tar -C "$REPO_ROOT" -czf "$TARBALL" \
    Dockerfile .dockerignore compose.yaml package.json bun.lock tsconfig.base.json \
    packages/core/package.json packages/core/src packages/core/tsconfig.json \
    packages/adapters/package.json packages/adapters/src packages/adapters/tsconfig.json \
    apps/server/package.json apps/server/src apps/server/drizzle \
    apps/web/package.json \
    tools scripts
log "tarball: $(du -h "$TARBALL" | cut -f1)"

# ── 3. Transfer ke staging remote (atomic swap setelah build sukses) ────
log "menyiapkan direktori VPS ($REMOTE_BASE/{app,backups,config,scripts})"
dexec "mkdir -p ${REMOTE_BASE}/app ${REMOTE_BASE}/backups ${REMOTE_BASE}/config ${REMOTE_BASE}/scripts"
# Bersihkan staging SEBELUM upload (bukan sesudah — rm setelah scp pernah
# menghapus tarball yang baru saja ditransfer).
dexec "rm -rf ${REMOTE_STAGING}; mkdir -p ${REMOTE_STAGING}"

log "transfer tarball -> VPS:${REMOTE_STAGING}/src.tar.gz"
dalang scp -q "$TARBALL" "${VPS}:${REMOTE_STAGING}/src.tar.gz"

log "ekstrak tarball di staging"
dexec "cd ${REMOTE_STAGING} && tar -xzf src.tar.gz && rm -f src.tar.gz && echo EXTRACTED"

# ── 4. Build image di VPS ────────────────────────────────────────────────
log "docker build (bisa beberapa menit — dipoll di background)"
: > /tmp/_local_marker
dexec "rm -f ${REMOTE_LOG}"
run_bg_and_wait "cd ${REMOTE_STAGING} && docker build -t crypastra-recorder:local . >> ${REMOTE_LOG} 2>&1" 600
log "build OK"

# ── 5. Atomic swap staging -> app ────────────────────────────────────────
log "swap staging -> ${REMOTE_APP}"
dexec "rm -rf ${REMOTE_APP}.prev; [[ -d ${REMOTE_APP} ]] && mv ${REMOTE_APP} ${REMOTE_APP}.prev; mv ${REMOTE_STAGING} ${REMOTE_APP}; mkdir -p ${REMOTE_STAGING}; echo SWAPPED"

# ── 6. Migrasi (bagian K): gagal migrasi = HENTIKAN, jangan lanjut start ─
log "menjalankan migrasi (docker run terpisah, sebelum compose up)"
dexec "rm -f ${REMOTE_LOG}"
if ! run_bg_and_wait "docker run --rm --env-file ${REMOTE_BASE}/config/crypastra.env -e CRYPASTRA_DB_PATH=/data/research.db -e CRYPASTRA_MIGRATIONS_DIR=/app/apps/server/drizzle -v crypastra-data:/data crypastra-recorder:local bun run apps/server/src/db/migrate.ts >> ${REMOTE_LOG} 2>&1" 120; then
    echo "[deploy] MIGRASI GAGAL. Compose TIDAK di-restart. Image lama (bila ada) tetap berjalan." >&2
    exit 1
fi
log "migrasi OK"

# ── 7. Recreate service ──────────────────────────────────────────────────
log "docker compose up -d (recreate crypastra-recorder)"
dexec "rm -f ${REMOTE_LOG}"
run_bg_and_wait "cd ${REMOTE_APP} && CRYPASTRA_IMAGE=crypastra-recorder:local docker compose up -d --no-build crypastra-recorder >> ${REMOTE_LOG} 2>&1" 60
log "compose up OK"

# ── 8. Tunggu health ──────────────────────────────────────────────────────
log "menunggu healthcheck (maks 90s, start_period compose 30s)"
HEALTHY=0
for _ in $(seq 1 18); do
    sleep 5
    STATUS="$(dexec "docker inspect --format '{{.State.Health.Status}}' \$(cd ${REMOTE_APP} && docker compose ps -q crypastra-recorder) 2>/dev/null")"
    log "  health=${STATUS:-unknown}"
    if [[ "$STATUS" == "healthy" ]]; then
        HEALTHY=1
        break
    fi
done

# ── 9. Status ringkas ─────────────────────────────────────────────────────
log "status akhir:"
dexec "cd ${REMOTE_APP} && docker compose ps"

if [[ "$HEALTHY" -eq 1 ]]; then
    log "DEPLOY SUKSES: crypastra-recorder sehat."
    dexec "rm -rf ${REMOTE_APP}.prev"
else
    log "PERINGATAN: belum sehat dalam 90s. Cek log: dalang exec ${VPS} \"cd ${REMOTE_APP} && docker compose logs --tail=60 crypastra-recorder\""
    log "Rollback tersedia di ${REMOTE_APP}.prev bila diperlukan (manual, TIDAK otomatis)."
fi
