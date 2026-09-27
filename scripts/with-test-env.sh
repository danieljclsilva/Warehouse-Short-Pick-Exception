#!/bin/sh
# Local test-environment wrapper. Loads .env.test (never .env), refuses
# anything that does not look like a disposable local database, then execs.
# In CI there is no .env.test and the service database is disposable by
# construction, so checks are skipped when CI=true.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$ROOT/.env.test" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.test"
  set +a

  URL="${DATABASE_URL:-}"
  if [ -z "$URL" ]; then
    echo "with-test-env: DATABASE_URL is not set in .env.test" >&2
    exit 1
  fi
  case "$URL" in
    *localhost*|*127.0.0.1*|*/tmp*|*.s.PGSQL.*) ;;
    *) echo "with-test-env: refusing non-local DATABASE_URL" >&2; exit 1 ;;
  esac
  NAME="$(printf '%s' "$URL" | sed -e 's/.*\///' -e 's/[?].*//')"
  case "$NAME" in
    *test*|shortpick_*) ;;
    *) echo "with-test-env: refusing database '$NAME': test DB name must contain 'test' or start with 'shortpick_'" >&2; exit 1 ;;
  esac
elif [ "${CI:-}" != "true" ]; then
  echo "with-test-env: missing $ROOT/.env.test (copy from .env.example test block)" >&2
  exit 1
fi

# Local E2E default: Homebrew postgres listens on 5432, not the script's 5433.
: "${E2E_POSTGRES_PORT:=5432}"
export E2E_POSTGRES_PORT

# Bake the test marker into any Next build/dev started through this wrapper
# so the UI renders the non-production banner. Production builds never run
# through this wrapper, so Railway stays clean.
: "${NEXT_PUBLIC_APP_ENV:=test}"
export NEXT_PUBLIC_APP_ENV

exec "$@"
