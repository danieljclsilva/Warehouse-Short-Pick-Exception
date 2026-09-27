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
  if ! node - "$URL" <<'NODE'
const value = process.argv[2];
let url;
try {
  url = new URL(value);
} catch {
  console.error("with-test-env: DATABASE_URL is not a valid PostgreSQL URL");
  process.exit(1);
}

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (!["postgres:", "postgresql:"].includes(url.protocol) || !localHosts.has(url.hostname.toLowerCase())) {
  console.error("with-test-env: refusing non-local DATABASE_URL");
  process.exit(1);
}
if (value.includes("?") || value.includes("#")) {
  console.error("with-test-env: DATABASE_URL must not include query parameters or a fragment");
  process.exit(1);
}

const name = decodeURIComponent(url.pathname.slice(1));
if (!/^[A-Za-z0-9_]+_test$/.test(name) || /^(shortpick_restore|shortpick_fixture)_/.test(name)) {
  console.error("with-test-env: database name must end in _test and must not be a restore or fixture database");
  process.exit(1);
}
NODE
  then
    exit 1
  fi
elif [ "${CI:-}" != "true" ]; then
  echo "with-test-env: missing $ROOT/.env.test; create it with DATABASE_URL pointing to a disposable local PostgreSQL database whose name ends in _test" >&2
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
