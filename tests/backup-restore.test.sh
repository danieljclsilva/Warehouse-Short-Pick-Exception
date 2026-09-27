#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
python3 "$ROOT/tests/backup_restore_integration.py" "$ROOT/backup/restore-backup.sh" "$TMP"
if [ "${RUN_REAL_POSTGRES_RESTORE:-0}" = 1 ]; then
  python3 "$ROOT/tests/backup_restore_postgres_integration.py" "$ROOT/backup/restore-backup.sh" "$TMP/real-postgres"
fi
