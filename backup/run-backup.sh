#!/bin/sh
set -eu
umask 077

die() { printf 'backup: %s\n' "$1" >&2; exit 1; }

is_managed_backup_key() {
  candidate=$1
  case "$candidate" in
    *.manifest.json) candidate=${candidate%.manifest.json} ;;
  esac
  case "$candidate" in postgres-logical/*) ;; *) return 1 ;; esac

  filename=${candidate#postgres-logical/}
  case "$filename" in *-*.dump.age) ;; *) return 1 ;; esac
  timestamp=${filename%%-*}
  nonce=${filename#*-}
  nonce=${nonce%.dump.age}
  case "$timestamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  case "$nonce" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) return 0 ;;
    *) return 1 ;;
  esac
}

JOB_TIMEOUT_SECONDS=${JOB_TIMEOUT_SECONDS:-14400}
case "$JOB_TIMEOUT_SECONDS" in ''|*[!0-9]*) die 'JOB_TIMEOUT_SECONDS must be a positive integer' ;; esac
[ "${#JOB_TIMEOUT_SECONDS}" -le 5 ] || die 'JOB_TIMEOUT_SECONDS cannot exceed 86399 seconds'
[ "$JOB_TIMEOUT_SECONDS" -gt 0 ] || die 'JOB_TIMEOUT_SECONDS must be a positive integer'
[ "$JOB_TIMEOUT_SECONDS" -le 86399 ] || die 'JOB_TIMEOUT_SECONDS cannot exceed 86399 seconds'
if [ "${1:-}" != '__backup_timeout_child' ]; then
  command -v timeout >/dev/null 2>&1 || die 'required command unavailable: timeout'
  set +e
  timeout --signal=TERM --kill-after=60s "${JOB_TIMEOUT_SECONDS}s" "$0" __backup_timeout_child
  status=$?
  set -e
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    printf 'backup: job exceeded configured timeout (%s seconds)\n' "$JOB_TIMEOUT_SECONDS" >&2
  fi
  exit "$status"
fi
shift

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ENDPOINT_URL:?S3_ENDPOINT_URL is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
S3_ADDRESSING_STYLE=${S3_ADDRESSING_STYLE:-virtual}
case "$S3_ADDRESSING_STYLE" in path|virtual) ;; *) die 'S3_ADDRESSING_STYLE must be path or virtual' ;; esac

for command in pg_dump age aws jq sha256sum date od timeout; do
  command -v "$command" >/dev/null 2>&1 || die "required command unavailable: $command"
done

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/shortpick-backup.XXXXXXXX") || die 'cannot create temporary directory'
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

UTC_STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
KEY_NONCE=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
TODAY=$(date -u '+%Y-%m-%d')
PREFIX='postgres-logical/'
OBJECT_KEY="${PREFIX}${UTC_STAMP}-${KEY_NONCE}.dump.age"
MANIFEST_KEY="${OBJECT_KEY}.manifest.json"
DUMP_FILE="$WORK_DIR/database.dump"
ENCRYPTED_FILE="$WORK_DIR/database.dump.age"
MANIFEST_FILE="$WORK_DIR/manifest.json"

printf 'backup: creating PostgreSQL logical dump at %s\n' "$UTC_STAMP"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$DUMP_FILE" || die 'pg_dump failed'
[ -s "$DUMP_FILE" ] || die 'pg_dump produced an empty file'
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$ENCRYPTED_FILE" "$DUMP_FILE" || die 'age encryption failed'
[ -s "$ENCRYPTED_FILE" ] || die 'age produced an empty encrypted file'
rm -f "$DUMP_FILE"

FILE_SIZE=$(wc -c < "$ENCRYPTED_FILE" | tr -d ' ')
FILE_SHA256=$(sha256sum "$ENCRYPTED_FILE" | awk '{print $1}')
jq -n --arg createdAt "${TODAY}T$(date -u '+%H:%M:%SZ')" \
  --arg key "$OBJECT_KEY" --arg sha256 "$FILE_SHA256" --arg recipient "$BACKUP_AGE_RECIPIENT" --argjson sizeBytes "$FILE_SIZE" \
  '{createdAt:$createdAt, objectKey:$key, sizeBytes:$sizeBytes, sha256:$sha256, ageRecipient:$recipient}' > "$MANIFEST_FILE"

aws s3 cp "$ENCRYPTED_FILE" "s3://${S3_BUCKET}/${OBJECT_KEY}" --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" --only-show-errors || die 'encrypted backup upload failed'
aws s3 cp "$MANIFEST_FILE" "s3://${S3_BUCKET}/${MANIFEST_KEY}" --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" --only-show-errors || die 'manifest upload failed'

# Verify the stored bytes and manifest, including S3-compatible providers that do not expose checksums.
aws s3 cp "s3://${S3_BUCKET}/${OBJECT_KEY}" "$WORK_DIR/verified.dump.age" --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" --only-show-errors || die 'backup download verification failed'
VERIFY_SIZE=$(wc -c < "$WORK_DIR/verified.dump.age" | tr -d ' ')
VERIFY_SHA256=$(sha256sum "$WORK_DIR/verified.dump.age" | awk '{print $1}')
[ "$VERIFY_SIZE" = "$FILE_SIZE" ] && [ "$VERIFY_SHA256" = "$FILE_SHA256" ] || die 'uploaded backup verification mismatch'
aws s3 cp "s3://${S3_BUCKET}/${MANIFEST_KEY}" "$WORK_DIR/verified-manifest.json" --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" --only-show-errors || die 'manifest download verification failed'
cmp -s "$MANIFEST_FILE" "$WORK_DIR/verified-manifest.json" || die 'uploaded manifest verification mismatch'
printf 'backup: uploaded and verified %s (%s bytes, sha256 %s)\n' "$OBJECT_KEY" "$FILE_SIZE" "$FILE_SHA256"

# Retention is deliberately downstream of all upload/readback checks. List pages are capped at 1000 keys.
KEEP_DAILY=' '
day_offset=0
while [ "$day_offset" -lt 14 ]; do
  retain_date=$(date -u -d "$TODAY - $day_offset days" '+%Y%m%d')
  KEEP_DAILY="${KEEP_DAILY}${retain_date} "
  day_offset=$((day_offset + 1))
done
KEEP_WEEKLY=' '
week_count=0
weekly_date="$TODAY"
while [ "$week_count" -lt 12 ]; do
  weekday=$(date -u -d "$weekly_date" '+%u')
  if [ "$weekday" -eq 7 ]; then
    weekly_stamp=$(date -u -d "$weekly_date" '+%Y%m%d')
    KEEP_WEEKLY="${KEEP_WEEKLY}${weekly_stamp} "
    week_count=$((week_count + 1))
  fi
  weekly_date=$(date -u -d "$weekly_date - 1 day" '+%Y-%m-%d')
done

continuation=''
while :; do
  PAGE="$WORK_DIR/list.json"
  if [ -n "$continuation" ]; then
    aws s3api list-objects-v2 --no-paginate --bucket "$S3_BUCKET" --prefix "$PREFIX" --max-keys 1000 --continuation-token "$continuation" --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" > "$PAGE" || die 'retention listing failed'
  else
    aws s3api list-objects-v2 --no-paginate --bucket "$S3_BUCKET" --prefix "$PREFIX" --max-keys 1000 --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" > "$PAGE" || die 'retention listing failed'
  fi
  jq -e '(.Contents == null) or (.Contents | type == "array")' "$PAGE" >/dev/null || die 'invalid retention listing response'
  jq -r '.Contents[]?.Key' "$PAGE" > "$WORK_DIR/page-keys"
  while IFS= read -r key; do
    if is_managed_backup_key "$key"; then
      stamp=${key#postgres-logical/}
      backup_day=$(printf '%s' "$stamp" | cut -c1-8)
      keep=false
      case "$KEEP_DAILY" in *" ${backup_day} "*) keep=true ;; esac
      if [ "$keep" = false ]; then
        case "$KEEP_WEEKLY" in *" ${backup_day} "*) keep=true ;; esac
      fi
      if [ "$keep" = false ]; then
        aws s3api delete-object --bucket "$S3_BUCKET" --key "$key" --endpoint-url "$S3_ENDPOINT_URL" --region "$AWS_REGION" >/dev/null || die 'retention deletion failed'
      fi
    fi
  done < "$WORK_DIR/page-keys"
  truncated=$(jq -r '.IsTruncated // false' "$PAGE")
  [ "$truncated" = true ] || break
  continuation=$(jq -er '.NextContinuationToken | strings | select(length > 0)' "$PAGE") || die 'truncated listing lacks continuation token'
done

printf 'backup: retention completed\n'
