#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

script = Path(sys.argv[1])
root = Path(sys.argv[2])
fixture = root / "fixture"
bin_dir = root / "bin"
fixture.mkdir(parents=True)
bin_dir.mkdir()
key = "postgres-logical/20260927T101112Z-012345abcdef.dump.age"
encrypted = b"encrypted-fixture-payload"
(fixture / "dump.age").write_bytes(encrypted)
(fixture / "manifest.json").write_text(json.dumps({"objectKey": key, "sizeBytes": len(encrypted), "sha256": hashlib.sha256(encrypted).hexdigest()}))
(fixture / "identity.txt").write_text("test-only identity")

def executable(name, body):
    path = bin_dir / name
    path.write_text("#!/bin/sh\nset -eu\n" + body + "\n")
    path.chmod(0o755)

executable("aws", '''
grep -Fx "    addressing_style = $EXPECTED_STYLE" "$AWS_CONFIG_FILE" >/dev/null
case "$3" in
  *.manifest.json) cp "$FIXTURE/manifest.json" "$4" ;;
  *) cp "$FIXTURE/dump.age" "$4" ;;
esac
''')
executable("age", 'while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; output=$1; fi; shift; done\ncp "$FIXTURE/dump.age" "$output"')
executable("psql", '''
case "$*" in
  *"CASE WHEN NOT EXISTS"*) printf '%s\\n' "${PSQL_EMPTY:-empty}" ;;
  *) printf '%s\\n' "${PSQL_EVIDENCE:-8|3|4}" ;;
esac
''')
executable("pg_restore", 'case " $* " in *" --single-transaction "*) touch "$RESTORE_MARKER" ;; *) exit 7 ;; esac')

env = os.environ.copy()
env.update({
    "PATH": f"{bin_dir}:{os.environ['PATH']}", "FIXTURE": str(fixture),
    "S3_BUCKET": "test-bucket", "S3_ENDPOINT_URL": "https://objects.invalid",
    "AWS_REGION": "test-region", "AWS_ACCESS_KEY_ID": "test-access",
    "AWS_SECRET_ACCESS_KEY": "test-secret", "BACKUP_AGE_IDENTITY_FILE": str(fixture / "identity.txt"),
    "BACKUP_OBJECT_KEY": key, "RESTORE_DATABASE_URL": "postgresql://tester:secret@localhost:5432/shortpick_restore_ci",
    "RESTORE_MARKER": str(root / "restored"), "EXPECTED_STYLE": "virtual",
})

def run(**changes):
    current = env.copy()
    current.update(changes)
    return subprocess.run(["sh", str(script)], env=current, text=True, capture_output=True)

# A corrupt or mismatched stored object must stop before decryption/restore.
(fixture / "dump.age").write_bytes(b"tampered")
result = run()
assert result.returncode != 0 and "checksum" in result.stderr, (result.returncode, result.stdout, result.stderr)
assert not Path(env["RESTORE_MARKER"]).exists()
(fixture / "dump.age").write_bytes(encrypted)

# Reject production-like names and nonlocal targets before any storage access.
for target in (
    "postgresql://x@y.example:5432/shortpick_restore_prod",
    "postgresql://x@localhost:5432/production",
    "postgresql://x@localhost:5432/shortpick_restore_ok?host=remote.example",
    "postgresql://x@localhost:5432/shortpick_restore_ok?hostaddr=203.0.113.10",
    "postgresql://x@localhost:5432/shortpick_restore_ok#remote",
):
    result = run(RESTORE_DATABASE_URL=target)
    assert result.returncode != 0 and "local disposable" in result.stderr
    assert not Path(env["RESTORE_MARKER"]).exists()

# Reject nonempty destinations without invoking pg_restore.
result = run(PSQL_EMPTY="nonempty")
assert result.returncode != 0 and "not empty" in result.stderr
assert not Path(env["RESTORE_MARKER"]).exists()

# The restore honors the runner's addressing-style contract and rejects unknown values.
result = run(S3_ADDRESSING_STYLE="path", EXPECTED_STYLE="path")
assert result.returncode == 0, result.stderr
Path(env["RESTORE_MARKER"]).unlink()
result = run(S3_ADDRESSING_STYLE="invalid")
assert result.returncode != 0 and "S3_ADDRESSING_STYLE" in result.stderr
assert not Path(env["RESTORE_MARKER"]).exists()

# Successful fixture verifies migrations and reports only database name and row counts.
result = run()
assert result.returncode == 0, result.stderr
assert "migrations=8" in result.stdout and "user_rows,case_rows=3|4" in result.stdout
assert "secret" not in result.stdout and "test-access" not in result.stdout
assert Path(env["RESTORE_MARKER"]).exists()
print("backup restore safety integration checks passed")
