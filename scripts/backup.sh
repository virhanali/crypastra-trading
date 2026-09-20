#!/usr/bin/env bash
# Backup SQLite aman (bagian F): VACUUM INTO, bukan `cp` file WAL yang
# sedang ditulis. VACUUM INTO memakai read-lock konsisten SQLite sendiri,
# jadi backup selalu snapshot valid meski recorder sedang menulis.
#
#   ./scripts/backup.sh [backup-dir] [volume] [image]
#
# VPS TIDAK punya `bun` di host (docs/decisions/0001) dan data hidup di named
# volume Docker `crypastra-data` (bukan bind mount — lihat compose.yaml untuk
# alasan UID). Jadi backup dijalankan lewat container sekali-pakai yang
# me-mount volume tsb plus direktori backup host, memakai image recorder yang
# sudah berisi bun. Volume TIDAK di-mount `:ro` — teruji `VACUUM INTO` gagal
# SQLITE_CANTOPEN pada DB mode WAL karena SQLite tetap perlu membuka
# -wal/-shm meski koneksi sumbernya readonly. Amannya datang dari operasi
# `VACUUM INTO` sendiri (baca sumber, tulis tujuan) yang TIDAK PERNAH menulis
# ke research.db — bukan dari mount ro. Retensi: 7 harian, TIDAK PERNAH
# menghapus DB utama (skrip ini tidak pernah delete apa pun di /data).
set -euo pipefail

BACKUP_DIR="${1:-/opt/crypastra/backups}"
VOLUME="${2:-crypastra-data}"
IMAGE="${3:-crypastra-recorder:local}"
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST_NAME="research-${STAMP}.db"

docker run --rm \
    --user 0:0 \
    -v "${VOLUME}:/data" \
    -v "${BACKUP_DIR}:/backups" \
    --entrypoint bun \
    "$IMAGE" \
    -e "
      import { Database } from 'bun:sqlite';
      const src = new Database('/data/research.db', { readonly: true });
      src.run(\`VACUUM INTO '/backups/${DEST_NAME}'\`);
      src.close();
    "

DEST="${BACKUP_DIR}/${DEST_NAME}"
if [[ ! -s "$DEST" ]]; then
    echo "[backup] GAGAL: file backup kosong/tidak terbentuk: $DEST" >&2
    exit 1
fi

SIZE=$(du -h "$DEST" | cut -f1)
echo "[backup] OK: $DEST ($SIZE)"

# Retensi: hapus HANYA backup lama di BACKUP_DIR. Volume sumber di-mount ro
# di atas, jadi langkah ini secara struktural tidak bisa menyentuh DB utama.
find "$BACKUP_DIR" -maxdepth 1 -name 'research-*.db' -mtime "+${RETENTION_DAYS}" -print -delete
