import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Verify actual descendants, including a grandchild that ignores TERM.
for (const action of ['timeout', 'TERM']) {
  test(`bounded runner kills child and grandchild on ${action}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bounded-test-'));
    const pidFile = join(dir, 'pids');
    const childCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const grand=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},process.pid+' '+grand.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const runner = spawn(process.execPath, ['scripts/railway-run-bounded.mjs', action === 'timeout' ? '1' : '30', process.execPath, '-e', childCode], { stdio: 'ignore' });
    const exit = new Promise((resolve) => runner.on('exit', resolve));
    let pids = [];
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(20);
      assert.ok(existsSync(pidFile), 'child started');
      pids = readFileSync(pidFile, 'utf8').split(' ').map(Number);
      if (action === 'TERM') runner.kill('SIGTERM');
      assert.equal(await exit, action === 'timeout' ? 124 : 143);
      await delay(100);
      for (const pid of pids) {
        let alive = false;
        try {
          const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim();
          alive = !!state && !state.startsWith('Z');
        } catch { /* no such process */ }
        assert.equal(alive, false, `descendant ${pid} no longer running`);
      }
    } finally {
      runner.kill('SIGKILL');
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(dir, {recursive:true,force:true});
    }
  });
}
