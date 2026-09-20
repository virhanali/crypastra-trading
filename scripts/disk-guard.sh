#!/usr/bin/env bash
# Disk guard (bagian G): laporkan, peringatkan, kritis. TIDAK PERNAH
# menghapus data riset. Pada kondisi kritis, hanya MELAPORKAN dan
# menyarankan penghentian recorder secara manual (docker compose stop) —
# recorder sendiri tidak dipaksa mati oleh skrip ini, karena mematikan
# proses paksa di tengah transaksi SQLite lebih berisiko daripada disk
# penuh yang sudah diberi peringatan dini.
#
#   ./scripts/disk-guard.sh [path] [warn-pct] [critical-pct]
#
# Default /var/lib/docker: data riset hidup di named volume Docker
# `crypastra-data` (bukan bind mount /opt/crypastra/data — lihat
# compose.yaml), jadi filesystem yang relevan untuk dipantau adalah root
# Docker (`docker info --format '{{.DockerRootDir}}'`), bukan /opt/crypastra.
set -euo pipefail

WATCH_PATH="${1:-/var/lib/docker}"
WARN_PCT="${2:-75}"
CRITICAL_PCT="${3:-90}"

if [[ ! -e "$WATCH_PATH" ]]; then
    echo "[disk-guard] GAGAL: path tidak ada: $WATCH_PATH" >&2
    exit 1
fi

USED_PCT=$(df -P "$WATCH_PATH" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
AVAIL_HUMAN=$(df -h "$WATCH_PATH" | awk 'NR==2 {print $4}')

echo "[disk-guard] $WATCH_PATH: ${USED_PCT}% terpakai, ${AVAIL_HUMAN} tersisa"

if (( USED_PCT >= CRITICAL_PCT )); then
    echo "[disk-guard] KRITIS: >= ${CRITICAL_PCT}% terpakai." >&2
    echo "[disk-guard] REKOMENDASI: hentikan recorder SEGERA secara manual" >&2
    echo "  (docker compose -f /opt/crypastra/app/compose.yaml stop crypastra-recorder)" >&2
    echo "[disk-guard] agar SQLite tidak menulis saat disk penuh (risiko korupsi WAL)." >&2
    echo "[disk-guard] Skrip ini TIDAK menghapus data riset maupun menghentikan container." >&2
    exit 2
elif (( USED_PCT >= WARN_PCT )); then
    echo "[disk-guard] PERINGATAN: >= ${WARN_PCT}% terpakai. Pertimbangkan backup + pembersihan manual." >&2
    exit 1
fi

exit 0
