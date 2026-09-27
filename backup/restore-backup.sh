#!/bin/sh
set -eu
umask 077

die() { printf 'restore: %s\n' "$1" >&2; exit 1; }

: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ENDPOINT_URL:?S3_ENDPOINT_URL is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required}"
: "${BACKUP_OBJECT_KEY:?BACKUP_OBJECT_KEY is required}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
S3_ADDRESSING_STYLE=${S3_ADDRESSING_STYLE:-virtual}
case "$S3_ADDRESSING_STYLE" in path|virtual) ;; *) die 'S3_ADDRESSING_STYLE must be path or virtual' ;; esac

for command in aws age jq sha256sum wc tr awk python3 pg_restore psql; do
  command -v "$command" >/dev/null 2>&1 || die "required command unavailable: $command"
done
[ -f "$BACKUP_AGE_IDENTITY_FILE" ] && [ -r "$BACKUP_AGE_IDENTITY_FILE" ] || die 'age identity file is unavailable'

# Parse the URL without printing it. Require a local host and a clearly disposable name.
python3 - "$RESTORE_DATABASE_URL" <<'PY' || die 'restore target must be a local disposable database named shortpick_restore_*'
import re, sys
from urllib.parse import urlsplit, unquote
try:
    u = urlsplit(sys.argv[1])
    host = (u.hostname or "").lower()
    database = unquote(u.path.lstrip("/"))
    port = u.port
except Exception:
    sys.exit(1)
if u.scheme not in ("postgres", "postgresql") or host not in ("localhost", "127.0.0.1"):
    sys.exit(1)
if u.query or u.fragment:
    sys.exit(1)
if port is not None and not (1 <= port <= 65535):
    sys.exit(1)
if not re.fullmatch(r"shortpick_restore_[a-z0-9_]+", database):
    sys.exit(1)
PY

case "$BACKUP_OBJECT_KEY" in
  postgres-logical/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].dump.age) ;;
  *) die 'object key is not a recognized logical backup key' ;;
esac

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/shortpick-restore.XXXXXXXX") || die 'cannot create temporary directory'
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT HUP INT TERM
trap 'exit 1' HUP INT TERM
AWS_CONFIG_FILE="$WORK_DIR/aws-config"
cat > "$AWS_CONFIG_FILE" <<EOF
[default]
region = ${AWS_REGION}
s3 =
    addressing_style = ${S3_ADDRESSING_STYLE}
EOF
export AWS_CONFIG_FILE
AWS_PROFILE=default
export AWS_PROFILE
ENCRYPTED_FILE="$WORK_DIR/backup.dump.age"
MANIFEST_FILE="$WORK_DIR/manifest.json"
DUMP_FILE="$WORK_DIR/backup.dump"
MANIFEST_KEY="${BACKUP_OBJECT_KEY}.manifest.json"

aws s3 cp "s3://${S3_BUCKET}/${BACKUP_OBJECT_KEY}" "$ENCRYPTED_FILE" --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" --only-show-errors >/dev/null || die 'backup download failed'
aws s3 cp "s3://${S3_BUCKET}/${MANIFEST_KEY}" "$MANIFEST_FILE" --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" --only-show-errors >/dev/null || die 'manifest download failed'
[ -s "$ENCRYPTED_FILE" ] && [ -s "$MANIFEST_FILE" ] || die 'backup or manifest is empty'

jq -e --arg key "$BACKUP_OBJECT_KEY" 'type == "object" and .objectKey == $key and (.sizeBytes | type == "number") and (.sizeBytes > 0) and (.sizeBytes == (.sizeBytes | floor)) and (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))' "$MANIFEST_FILE" >/dev/null || die 'manifest is invalid'
EXPECTED_SIZE=$(jq -r '.sizeBytes' "$MANIFEST_FILE")
EXPECTED_SHA256=$(jq -r '.sha256' "$MANIFEST_FILE")
ACTUAL_SIZE=$(wc -c < "$ENCRYPTED_FILE" | tr -d ' ')
ACTUAL_SHA256=$(sha256sum "$ENCRYPTED_FILE" | awk '{print $1}')
[ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] && [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || die 'backup checksum or size verification failed'

age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$DUMP_FILE" "$ENCRYPTED_FILE" >/dev/null 2>&1 || die 'backup decryption failed'
[ -s "$DUMP_FILE" ] || die 'decrypted dump is empty'

# Do not create, drop, or modify an existing target until it is confirmed empty.
EMPTY=$(psql "$RESTORE_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%') THEN 'empty' ELSE 'nonempty' END" 2>/dev/null) || die 'cannot inspect restore target'
[ "$EMPTY" = empty ] || die 'restore target is not empty'

pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname "$RESTORE_DATABASE_URL" "$DUMP_FILE" >/dev/null 2>&1 || die 'database restore failed'
EVIDENCE=$(psql "$RESTORE_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations), (SELECT count(*) FROM public.users), (SELECT count(*) FROM public.order_cases)" 2>/dev/null) || die 'restored migration or table verification failed'
case "$EVIDENCE" in
  *'|'*) ;;
  *) die 'restored database evidence is invalid' ;;
esac
MIGRATIONS=${EVIDENCE%%|*}
case "$MIGRATIONS" in ''|*[!0-9]*) die 'migration verification failed' ;; esac
[ "$MIGRATIONS" -gt 0 ] || die 'restored database has no tracked migrations'
COUNTS=${EVIDENCE#*|}
printf 'restore: verified database %s; migrations=%s; user_rows,case_rows=%s\n' "$(python3 -c 'from urllib.parse import urlsplit,unquote; import sys; print(unquote(urlsplit(sys.argv[1]).path.lstrip("/")))' "$RESTORE_DATABASE_URL")" "$MIGRATIONS" "$COUNTS"
