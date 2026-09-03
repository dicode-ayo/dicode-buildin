# dicode-buildin

The `buildin` taskset — the standard inventory a [dicode](https://github.com/dicode-ayo/dicode-core)
daemon ships with. Every task here is a Deno task resolved over git at runtime, so a fix
lands on running daemons at their next reconciler poll (~30s) without a dicode release.

The daemon namespaces these tasks under `buildin/`, and that namespace is auto-approved
(`pkg/approval/gate.go` in dicode-core) — tasks from this repo arm without an approval
prompt. Treat a change here as a change to what every daemon runs.

## What's in here

| Task | Role |
|---|---|
| `webui` | The dashboard SPA (`webui/app/`) and its routes. dicode-core only embeds `dicode.js` and the login page; everything else you see in the UI is served from here. |
| `mcp` | The MCP server the daemon forwards `/mcp` to. |
| `tray` | System tray icon, via a portable systray helper — no CGo. |
| `notify`, `telegram`, `alert` | Notification delivery. `notify` is the desktop default; `telegram` reaches a headless host. |
| `ai-agent`, `ai-agent-claude-cli`, `ai-agent-core` | The AI agent base and its Claude-CLI variant. `taskset.yaml` layers `dicodai`, `auto-fix` and `task-create-turn` on top as overrides. |
| `task-create`, `write-task-file`, `verify-task-written`, `git-pr` | The AI task-authoring loop: scaffold, write, check, land. |
| `auth-start`, `auth-relay`, `auth-providers` | The OAuth PKCE handshake against the dicode-relay broker. |
| `relay-client`, `relay-server`, `relay-server-body` | The WebSocket tunnel that gives webhooks a public URL. |
| `local-storage`, `blob-storage`, `secret-providers/doppler` | Storage and secret-provider backends. |
| `temp-cleanup`, `dev-clones-cleanup`, `run-inputs-cleanup`, `audit-export-loki` | Housekeeping crons and audit export. |
| `template`, `write-local` | Pipeline stages, used by `relay-server`; not standalone entries. |

`taskset.yaml` is the manifest. An entry can point at a task directory directly or layer
`overrides` onto another entry's task — `dicodai`, `auto-fix` and `task-create-turn` are all
overrides of `ai-agent/`, which is why the entry count exceeds the directory count.

`skills/` holds the markdown skills the agent tasks load into their system prompt, reached
via `${TASK_SET_DIR}/skills`.

## Using it

A daemon picks this up as a `spec.entries` ref in `dicode.yaml`:

```yaml
spec:
  entries:
    buildin:
      ref:
        url: https://github.com/dicode-ayo/dicode-buildin
        branch: main
        path: taskset.yaml
        poll_interval: 30s
```

The entry **must** be named `buildin` — task IDs are namespaced by the entry key, and both
the auto-approval rule and dicode-core's own references (`buildin/dicodai`,
`buildin/write-task-file`, …) key off that name.

## Developing

Point a daemon at a local clone instead of the git URL, so edits reload without a push:

```yaml
spec:
  entries:
    buildin:
      ref:
        path: /path/to/dicode-buildin/taskset.yaml
        watch: true
```

Then:

```bash
deno task test                       # all task.test.ts, in-memory mocks, no daemon
dicode deno relock .                 # regenerate deno.lock after changing imports
dicode deno relock --check .         # what CI asserts
dicode task test buildin/webui       # run one task's tests through the daemon
```

`sdk.ts` is the type surface a task imports (`import type { DicodeSdk } from "../sdk.ts"`);
`sdk-test.ts` is the mock harness its tests import. Both are copies of the contract
dicode-core implements in `pkg/runtime/deno/sdk/` — if they drift, dicode-core is right.

## CI

Two jobs, in `.github/workflows/ci.yml`:

- **Test tasks (Deno)** — `deno test` over every `task.test.ts`.
- **Load and test via the dicode daemon** — downloads the latest dicode release, checks
  `deno.lock` is current, boots a daemon against this repo, and asserts that every
  `taskset.yaml` entry actually registered. A `task.yaml` the strict validator rejects never
  registers, so this catches spec errors that unit tests cannot see.

## Cross-repo notes

Paths and docs referenced as `docs/…`, `pkg/…` or `tasks/examples/…` live in
[dicode-core](https://github.com/dicode-ayo/dicode-core), not here.
