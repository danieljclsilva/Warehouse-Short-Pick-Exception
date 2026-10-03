# Director / OMP manager protocol

The director owns scope, material product decisions, final verification, and release approval. The OMP manager owns decomposition, subagent assignments, integration, routine troubleshooting, tests, and a concise final handoff. Workers are not alone in the codebase: each gets explicit file ownership and must preserve others' changes.

## Current batch

- Baseline: `b9c54ae` (verification report committed).
- Implementation branch: `codex/verification-fixes`.
- Worktree: `/Users/komorinokage/.codex/worktrees/verification-fixes/ShortPickException`.
- Run directory: `/Users/komorinokage/.codex/omp-runs/shortpick-verification-20261003`.
- Manager and substantive workers: `opencode-go/muse-spark-1.3-contributor`; mechanical workers may use `opencode-go/longcat-2.5-preview-free`. These are locally available model IDs; pricing is not independently established here.
- Scope: the six findings in `VERIFICATION_REPORT_2026-10-03.md`, with focused regression coverage and a usable recovery UI. Preserve state-only replenishment inputs in this batch; flag the conflicting PRD requirement for a product decision. Do not invent a broader workflow change.
- Soft checkpoint: one hour after launch; hard process limit: 90 minutes. These are operational checkpoints, not a promise of completion. At the soft checkpoint, reduce scope to a coherent reviewed handoff if needed; never label unfinished work complete.
- Manager may commit reviewed slices on its branch. No push, merge into main, deployment, production database access, or changes to credentials/permissions outside the application task.

## Communication without routine director intervention

The durable mailbox avoids starting another Codex CLI agent. It is asynchronous, with up to ten minutes between scheduled director inspections; it is not an immediate push callback.

- Director → manager: append numbered instructions to `director-inbox.md`. Manager reads it before dispatch, after each worker settles, before integration/gates, and before handoff. It records the last processed instruction number in `status.json`.
- Manager → director: maintain compact `status.json` (phase, last update, task statuses/owners, processed instruction number, blockers, next milestone). Keep it under 4 KB and replace atomically. Update at milestones and at least every five minutes when actively working.
- Escalation: write `signal.json` with a unique ID, `kind` (`blocked` or `review_ready`), short summary, recommended decision, alternatives, and artifact paths. Update `handoff.md` first when requesting review. Check for the director's response in the inbox. Continue independent work when possible.
- Routine model/tool retries, naming, CSS choices, test fixes, and worker scheduling belong to the manager. Escalate material scope/product uncertainty, unrecoverable environment failure, repeated failures after two useful attempts, or a deadline threatening a coherent result.
- Director inspects compact status and supervisor `process.json`, not the full transcript. Read `manager.log` only for a concrete crash/stall. A silent unchanged check requires no user notification. Process exit alone is never acceptance.
- At review: provide commits, files, six-item acceptance matrix, exact gates and outcomes, browser evidence, limitations, and residual product decisions. Director independently verifies consequential paths, then accepts or sends one consolidated repair request.
- After final acceptance or an unrecoverable stopped run, remove the run's scheduled heartbeat. Preserve branch and handoff. Do not archive the user's chat.

The Codex app must remain running and the workstation available for local scheduled checks. Runtime transcripts and status live outside the repository; no secret or production data belongs in a mailbox or handoff.
