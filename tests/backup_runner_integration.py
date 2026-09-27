#!/usr/bin/env python3
"""End-to-end runner checks using real shell orchestration and a filesystem-backed S3 fixture."""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


RUNNER = Path(sys.argv[1])
ROOT_TMP = Path(sys.argv[2])
sys.argv = [sys.argv[0]]


class BackupRunnerIntegration(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=ROOT_TMP))
        self.bin = self.root / "bin"
        self.store = self.root / "bucket"
        self.bin.mkdir()
        self.store.mkdir()
        self.temp = self.root / "tmp"
        self.temp.mkdir()
        self._command("pg_dump", """#!/bin/sh
set -eu
out=
while [ $# -gt 0 ]; do
  case "$1" in --file=*) out=${1#*=}; shift ;; --file) out=$2; shift 2 ;; *) shift ;; esac
done
[ "${MOCK_SLOW_DUMP:-0}" != 1 ] || sleep 10
printf 'fixture database bytes\000with binary data' > "$out"
""")
        self._command("age", """#!/bin/sh
set -eu
while [ $# -gt 0 ]; do
  case "$1" in --output) output=$2; shift 2 ;; --encrypt) shift ;; --recipient) shift 2 ;; *) input=$1; shift ;; esac
done
{ printf 'AGE-FIXTURE\\000'; cat "$input"; } > "$output"
""")
        self._command("aws", """#!/bin/sh
set -eu
if [ "$1 $2" = 's3 cp' ]; then
  grep -q 'addressing_style = path' "$AWS_CONFIG_FILE" || exit 8
  source=$3; dest=$4
  case "$source" in
    s3://*)
      [ "${MOCK_FAIL_DOWNLOAD:-0}" != 1 ] || exit 9
      key=${source#s3://*/}
      cp "$MOCK_S3_ROOT/$key" "$dest" ;;
    *) key=${dest#s3://*/}; mkdir -p "$MOCK_S3_ROOT/$(dirname "$key")"; cp "$source" "$MOCK_S3_ROOT/$key" ;;
  esac
elif [ "$1 $2" = 's3api list-objects-v2' ]; then
  exec "$(dirname "$0")/mock-list.py" "$@"
elif [ "$1 $2" = 's3api delete-object' ]; then
  shift 2; while [ $# -gt 0 ]; do if [ "$1" = --key ]; then key=$2; break; fi; shift; done
  rm -f "$MOCK_S3_ROOT/$key"
else exit 2; fi
""")
        self._command("mock-list.py", """#!/usr/bin/env python3
import json, os, pathlib, sys
args=sys.argv[1:]
assert '--no-paginate' in args
assert args[args.index('--max-keys')+1] == '1000'
value=lambda flag: args[args.index(flag)+1]
store=pathlib.Path(os.environ['MOCK_S3_ROOT']); prefix=value('--prefix')
token=value('--continuation-token') if '--continuation-token' in args else None
if os.environ.get('MOCK_EMPTY_LIST') == '1':
    print(json.dumps({'IsTruncated':False})); raise SystemExit(0)
keys=sorted(str(p.relative_to(store)) for p in store.rglob('*') if p.is_file() and str(p.relative_to(store)).startswith(prefix))
if token: keys=[key for key in keys if key>token]
page=keys[:1000]
with open(os.environ['MOCK_LIST_LOG'],'a') as log: log.write(json.dumps({'token':token,'keys':page})+'\\n')
print(json.dumps({'Contents':[{'Key':k} for k in page], 'IsTruncated':len(keys)>len(page), **({'NextContinuationToken':page[-1]} if len(keys)>len(page) else {})}))
""")
        self._command("date", """#!/usr/bin/env python3
import datetime as dt, re, sys
args=sys.argv[1:]
fmt=args[-1].lstrip('+')
now=dt.datetime.now(dt.timezone.utc)
if '-d' in args:
    value=args[args.index('-d')+1]
    match=re.fullmatch(r'(\\d{4}-\\d{2}-\\d{2}) - (\\d+) days?', value)
    if match:
        now=dt.datetime.combine(dt.date.fromisoformat(match.group(1))-dt.timedelta(days=int(match.group(2))),dt.time(),dt.timezone.utc)
    else: now=dt.datetime.combine(dt.date.fromisoformat(value),dt.time(),dt.timezone.utc)
formats={'%Y%m%dT%H%M%SZ':now.strftime('%Y%m%dT%H%M%SZ'),'%Y-%m-%d':now.strftime('%Y-%m-%d'),'%H:%M:%SZ':now.strftime('%H:%M:%SZ'),'%Y%m%d':now.strftime('%Y%m%d'),'%u':str(now.isoweekday())}
print(formats.get(fmt, now.strftime(fmt)))
""")

    def _command(self, name, source):
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o755)

    def _env(self, **extra):
        return {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "MOCK_S3_ROOT": str(self.store),
                "MOCK_LIST_LOG": str(self.root/"list-calls"),
                "TMPDIR": str(self.temp),
                "DATABASE_URL": "postgresql://fixture.invalid/db", "BACKUP_AGE_RECIPIENT": "x",
                "S3_BUCKET": "fixtures", "S3_ENDPOINT_URL": "http://fixture.invalid",
                "AWS_REGION": "test-1", "AWS_ACCESS_KEY_ID": "dummy", "AWS_SECRET_ACCESS_KEY": "dummy",
                "S3_ADDRESSING_STYLE": "path",
                "TZ": "UTC", **extra}

    def _run(self, **env):
        return subprocess.run([str(RUNNER)], env=self._env(**env), text=True, capture_output=True)

    def _seed(self, day, suffix="000000Z"):
        key=f"postgres-logical/{day}T{suffix}-0123456789ab.dump.age"
        (self.store/key).parent.mkdir(parents=True, exist_ok=True)
        (self.store/key).write_bytes(b"old encrypted")
        (self.store/(key+".manifest.json")).write_text("{}")

    def test_uploads_encrypted_dump_manifest_and_readback_verifies(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        objects = sorted(str(p.relative_to(self.store)) for p in self.store.rglob('*') if p.is_file())
        self.assertEqual(len(objects), 2)
        backup = next(p for p in self.store.rglob("*.dump.age") if not p.name.endswith("manifest.json"))
        content = backup.read_bytes()
        self.assertTrue(content.startswith(b"AGE-FIXTURE\0"))
        manifest = json.loads(Path(str(backup)+".manifest.json").read_text())
        import hashlib
        self.assertEqual(manifest["sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(manifest["sizeBytes"], len(content))
        self.assertEqual(manifest["ageRecipient"], "x")
        self.assertEqual(list(self.temp.iterdir()), [])

    def test_readback_failure_is_nonzero_and_retention_does_not_run(self):
        old = "20000101"
        self._seed(old)
        result = self._run(MOCK_FAIL_DOWNLOAD="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.store/f"postgres-logical/{old}T000000Z-0123456789ab.dump.age").exists())
        self.assertIn("verification", result.stderr)

    def test_retention_listing_follows_a_second_s3_page(self):
        prefix=self.store/"postgres-logical"
        prefix.mkdir()
        page_one_day="20000101"
        page_two_day="20100101"
        self._seed(page_one_day)
        for n in range(999):
            (prefix/f"2005-unmanaged-{n:04d}").touch()
        self._seed(page_two_day)
        result=self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        for day in (page_one_day,page_two_day):
            self.assertFalse((prefix/f"{day}T000000Z-0123456789ab.dump.age").exists(), f"expired artifact for {day} should be deleted")
            self.assertFalse((prefix/f"{day}T000000Z-0123456789ab.dump.age.manifest.json").exists(), f"expired manifest for {day} should be deleted")
        pages=[json.loads(line) for line in (self.root/"list-calls").read_text().splitlines()]
        self.assertEqual(len(pages), 2)
        self.assertIsNone(pages[0]["token"])
        self.assertEqual(pages[1]["token"], pages[0]["keys"][-1])
        self.assertTrue(any(f"{page_two_day}T000000Z-0123456789ab.dump.age" == key.split("/")[-1] for key in pages[1]["keys"]))

    def test_empty_listing_without_contents_is_successful(self):
        result=self._run(MOCK_EMPTY_LIST="1")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_job_timeout_is_bounded_and_logged(self):
        result=self._run(JOB_TIMEOUT_SECONDS="1", MOCK_SLOW_DUMP="1")
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertIn("job exceeded configured timeout (1 seconds)", result.stderr)
        invalid=self._run(JOB_TIMEOUT_SECONDS="86400")
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("cannot exceed 86399 seconds", invalid.stderr)

    def test_retention_keeps_recent_daily_and_twelve_sundays(self):
        today = dt.datetime.now(dt.timezone.utc).date()
        recent = {today-dt.timedelta(days=n) for n in range(14)}
        weekly=set()
        offset=0
        while len(weekly)<12:
            day=today-dt.timedelta(days=offset)
            if day.weekday()==6: weekly.add(day)
            offset+=1
        expired={today-dt.timedelta(days=offset+1), today-dt.timedelta(days=offset+3)}
        dates=recent|weekly|expired
        for day in dates:
            self._seed(day.strftime("%Y%m%d"))
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        retained = {p.name[:8] for p in self.store.glob("postgres-logical/*.dump.age") if not p.name.endswith("manifest.json")}
        expected = {day.strftime("%Y%m%d") for day in recent|weekly}
        self.assertEqual(retained, expected)
        for key in retained:
            self.assertTrue((self.store/f"postgres-logical/{key}T000000Z-0123456789ab.dump.age.manifest.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
