#!/usr/bin/env node
// railway-run-bounded.mjs — run one command with a hard timeout.
//
// Portable alternative to GNU timeout(1) (absent on macOS): pure node,
// no new dependencies. Used by scripts/railway-test-env.sh so --timeout is
// a real deadline even when a Railway/SSH child hangs forever.
//
// Usage: node railway-run-bounded.mjs <seconds> <cmd> [args...]
// Exit: child status; 124 on timeout; 130 on INT; 143 on TERM.
// The child runs as a process-group leader; timeout/signal kills the whole
// group (child + descendants such as stub sleeps or CLI-spawned helpers).

import { spawn } from "node:child_process";

const rawSecs = Number.parseInt(process.argv[2], 10);
const secs = Number.isInteger(rawSecs) && rawSecs > 0 ? rawSecs : 60;
const cmd = process.argv[3];
const args = process.argv.slice(4);

if (!cmd) {
  console.error("run-bounded: missing command");
  process.exit(2);
}

let child;
try {
  child = spawn(cmd, args, {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
} catch (err) {
  console.error(`run-bounded: spawn failed: ${(err && err.message) || err}`);
  process.exit(127);
}

let finished = false;

function killGroup(sig) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    // Group already gone; fall through to the direct kill.
  }
  try {
    child.kill(sig);
  } catch {
    // Already exited; the exit handler settles the status.
  }
}

const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  killGroup("SIGKILL");
  console.error(`run-bounded: timed out after ${secs}s: ${cmd} ${args.join(" ")}`);
  process.exit(124);
}, secs * 1000);

child.on("error", (err) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.error(`run-bounded: exec failed: ${(err && err.message) || err}`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (signal) {
    process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  }
  process.exit(code === null || code === undefined ? 1 : code);
});

function onSignal(sig, code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  killGroup("SIGKILL");
  process.exit(code);
}

process.on("SIGTERM", () => onSignal("SIGTERM", 143));
process.on("SIGINT", () => onSignal("SIGINT", 130));
