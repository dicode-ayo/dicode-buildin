# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this repo is

The `buildin` taskset: the tasks a [dicode](https://github.com/dicode-ayo/dicode-core) daemon
loads as its standard inventory. All Deno; no Go, no build step. `README.md` has the
per-task table.

Two things make edits here higher-stakes than an ordinary task repo:

- Daemons resolve this over git and reconcile every ~30s, so a push to `main` reaches
  running installs without a release.
- The `buildin/` namespace is auto-approved in dicode-core's approval gate, so tasks from
  here arm with no approval prompt and no content-hash check.

## Commands

```bash
deno task test                  # every task.test.ts (in-memory mocks, no daemon)
deno test --allow-all --config=deno.json './webui/task.test.ts'   # one file
dicode deno relock .            # regenerate deno.lock after changing imports
dicode deno relock --check .    # what CI asserts
dicode task test buildin/<id>   # run a task's tests through a live daemon
```

`deno check` is **not** a gate here: ~27 pre-existing errors come from tasks that rely on
ambient runtime globals rather than importing their types. Use it to compare against a
baseline, not as a pass/fail.

## Layout

```
taskset.yaml        manifest — every entry the daemon registers
sdk.ts              type surface tasks import
sdk-test.ts         mock harness task tests import
deno.json/lock      shared config + lockfile for the whole repo
skills/             markdown skills the agent tasks load
<task>/             task.yaml + task.ts + task.test.ts
```

`taskset.yaml` entry count exceeds the directory count: `dicodai`, `auto-fix` and
`task-create-turn` are `overrides` layered onto `ai-agent/`. **`overrides` REPLACE, they do
not merge** — an override that sets `permissions.fs` drops the base task's fs grants
entirely, so restate every path the entry still needs (the skills-directory grant in
particular).

`template/` and `write-local/` are pipeline stages of `relay-server`, not standalone
entries. They have no `taskset.yaml` entry and are not directly runnable.

## Editing a task

A task is `task.yaml` + `task.ts` + `task.test.ts`, changed together. Never ship one
without the others.

`task.yaml` holds exactly one trigger. Every outbound host goes under `permissions.net` and
every environment variable under `permissions.env` — the daemon derives Deno's `--allow-*`
flags from these, so an undeclared host or variable fails at runtime, not at load. Never
hardcode a secret; name it in `permissions.env` and read it with `Deno.env.get`.

The Deno handler receives `{ params, kv, input, state, output, mcp, dicode }` — the
`DicodeSdk` interface in `sdk.ts`. There is **no `env` object and no `log` object**: read
configuration with `Deno.env.get`, and write to the run log with `console.log`, which the
runtime streams through a secrets redactor. Native `fetch` is available.

Paths are relative to the repo root, one level up from a task directory:

```typescript
import type { DicodeSdk } from "../sdk.ts";        // ../../ from secret-providers/doppler
import { setupHarness } from "../sdk-test.ts";
```

`${TASK_SET_DIR}` expands to this repo's root at task-load time, so the skills directory is
`${TASK_SET_DIR}/skills`.

## Verifying a change

`deno task test` is the fast loop, but it only proves the logic. A `task.yaml` the daemon's
strict validator rejects still passes `deno test` — it simply never registers. Before
calling a spec change done, boot a daemon against a local clone and confirm the task
appears in `dicode list`. CI's second job does exactly this and asserts the registered
count matches the manifest.

## Cross-repo

`docs/…`, `pkg/…`, `tasks/examples/…` and `tasks/auth/…` refer to
[dicode-core](https://github.com/dicode-ayo/dicode-core). `sdk.ts` and `sdk-test.ts` mirror
the contract dicode-core implements in `pkg/runtime/deno/sdk/`; if they disagree,
dicode-core is authoritative.
