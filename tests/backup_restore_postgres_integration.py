#!/usr/bin/env python3
"""Exercise the restore drill against real local PostgreSQL, using age/S3 test shims."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

script = Path(sys.argv[1])
work = Path(sys.argv[2])
pg_bin = Path("/Applications/Postgres.app/Contents/Versions/latest/bin")
if not (pg_bin / "pg_dump").is_file() or not (pg_bin / "pg_restore").is_file():
    pg_bin = Path("/Applications/Postgres.app/Contents/Versions/16/bin")
pg_env = os.environ.copy()
pg_env["PATH"] = f"{pg_bin}:{pg_env['PATH']}"
work.mkdir(parents=True)
run_id = uuid.uuid4().hex[:10]
fixture_db = f"shortpick_fixture_{run_id}"
restore_db = f"shortpick_restore_test_{run_id}"
created = []

pg_host = os.environ.get("E2E_POSTGRES_HOST") or os.environ.get("PGHOST") or "localhost"
pg_port = str(os.environ.get("E2E_POSTGRES_PORT") or os.environ.get("PGPORT") or "5432")

def call(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)

try:
    try:
        identity = call(["psql", "-h", pg_host, "-p", pg_port, "-X", "-qAt", "-d", "postgres", "-c", "SELECT current_user"])
    except FileNotFoundError:
        print("real PostgreSQL restore check skipped: psql unavailable")
        raise SystemExit(0)
    if identity.returncode:
        print("real PostgreSQL restore check skipped: local postgres database unavailable")
        raise SystemExit(0)
    user = identity.stdout.strip()
    admin_url = f"postgresql://{user}@{pg_host}:{pg_port}/postgres"
    for name in (fixture_db, restore_db):
        created_db = call(["psql", admin_url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", f'CREATE DATABASE "{name}"'])
        if created_db.returncode:
            raise RuntimeError("could not create test-owned disposable database")
        created.append(name)

    fixture_url = f"postgresql://{user}@{pg_host}:{pg_port}/{fixture_db}"
    setup = call(["psql", fixture_url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL); INSERT INTO drizzle.__drizzle_migrations (hash) VALUES ('fixture'); CREATE TABLE public.users (id integer PRIMARY KEY); INSERT INTO public.users VALUES (1), (2); CREATE TABLE public.order_cases (id integer PRIMARY KEY); INSERT INTO public.order_cases VALUES (1);"])
    if setup.returncode:
        raise RuntimeError("could not prepare PostgreSQL fixture")
    dump = work / "fixture.dump"
    dumped = call(["pg_dump", "--format=custom", "--no-owner", "--no-acl", "--file", str(dump), fixture_url], env=pg_env)
    if dumped.returncode or not dump.is_file():
        raise RuntimeError("could not create custom PostgreSQL fixture dump")

    object_key = "postgres-logical/20260927T101112Z-012345abcdef.dump.age"
    age_file = work / "backup.dump.age"
    shutil.copyfile(dump, age_file)
    size = age_file.stat().st_size
    (work / "manifest.json").write_text(json.dumps({"objectKey": object_key, "sizeBytes": size, "sha256": hashlib.sha256(age_file.read_bytes()).hexdigest()}))
    identity_file = work / "identity.txt"
    identity_file.write_text("fixture only")
    shim_bin = work / "shims"
    shim_bin.mkdir()
    (shim_bin / "aws").write_text('#!/bin/sh\nset -eu\ngrep -Fx "    addressing_style = path" "$AWS_CONFIG_FILE" >/dev/null\ncase "$3" in *.manifest.json) cp "$FIXTURE_DIR/manifest.json" "$4" ;; *) cp "$FIXTURE_DIR/backup.dump.age" "$4" ;; esac\n')
    (shim_bin / "age").write_text('#!/bin/sh\nset -eu\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; output=$1; fi; shift; done\ncp "$FIXTURE_DIR/backup.dump.age" "$output"\n')
    for shim in (shim_bin / "aws", shim_bin / "age"):
        shim.chmod(0o755)
    env = os.environ.copy()
    env.update({
        "PATH": f"{shim_bin}:{pg_bin}:{env['PATH']}", "FIXTURE_DIR": str(work),
        "S3_BUCKET": "fixture-bucket", "S3_ENDPOINT_URL": "https://objects.invalid",
        "AWS_REGION": "fixture-region", "AWS_ACCESS_KEY_ID": "fixture-access",
        "AWS_SECRET_ACCESS_KEY": "fixture-secret", "BACKUP_AGE_IDENTITY_FILE": str(identity_file),
        "BACKUP_OBJECT_KEY": object_key, "RESTORE_DATABASE_URL": f"postgresql://{user}@{pg_host}:{pg_port}/{restore_db}",
        "S3_ADDRESSING_STYLE": "path",
    })
    restored = call(["sh", str(script)], env=env)
    if restored.returncode:
        raise RuntimeError(f"restore script rejected real fresh database: {restored.stderr.strip()}")
    if "migrations=1" not in restored.stdout or "user_rows,case_rows=2|1" not in restored.stdout:
        raise RuntimeError("real restore evidence did not match fixture rows")
    print(f"real local PostgreSQL {pg_bin.parent.name} restore check passed (fresh public schema, migrations=1, users=2, cases=1)")
finally:
    # Drop only databases whose CREATE DATABASE command succeeded in this test.
    for name in reversed(created):
        call(["dropdb", "-h", pg_host, "-p", pg_port, "--if-exists", name])
