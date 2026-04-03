# dicode-buildin

This is the **dicode-builtin** repository — a standard TaskSet source that `dicoded` auto-loads on first start, containing the daemon's built-in tasks extracted from the main `dicode-core` repo.

## Purpose

Move core infrastructure out of the compiled Go binary into versioned, hot-reloadable Deno tasks:

| Task | Issue | Status | Description |
|------|-------|--------|-------------|
| `webui` | [#58](https://github.com/dicode-ayo/dicode-core/issues/58) | open | Dashboard SPA served as a Deno daemon task, replacing `pkg/webui/` (~3000 lines Go) |
| `notify` | [#60](https://github.com/dicode-ayo/dicode-core/issues/60) | open | Native OS desktop notifications via `deno_notify`, replacing SW-based browser notifications |
| `tray` | [#59](https://github.com/dicode-ayo/dicode-core/issues/59) | open | System tray icon as Deno daemon task, removing CGO dependency from `dicoded` |

## Source repo

The main dicode daemon lives at `/home/dr14/dicode/`. Read it to understand protocols, APIs, and existing implementations being migrated here.

Key paths:
- `/home/dr14/dicode/pkg/webui/` — Go WebUI being replaced by `webui/` task here
- `/home/dr14/dicode/pkg/notify/` — Go notify package; `notify/` task here replaces SW notifications
- `/home/dr14/dicode/pkg/tray/` — Go CGO tray; `tray/` task here removes CGO
- `/home/dr14/dicode/examples/webui/` — existing SPA assets (app/, sw.js, dc-notif-panel.js) to port
- `/home/dr14/dicode/pkg/runtime/deno/sdk/shim.js` — Deno shim globals (`log`, `params`, `kv`, `http`, etc.)
- `/home/dr14/dicode/pkg/task/spec.go` — Task spec struct (authoritative schema)

## Task structure

Every task in this repo is a directory with:

```
<task-name>/
  task.yaml   # task specification
  task.ts     # Deno TypeScript implementation
  task.test.ts  # (optional) tests
```

Top-level `taskset.yaml` composes all tasks.

### task.yaml schema

```yaml
apiVersion: dicode/v1
kind: Task
name: "Task Name"
description: "..."
runtime: deno          # deno | docker | podman | python | ai | wasm

trigger:
  daemon: true         # long-running service
  # OR cron / webhook / manual / chain

params:
  - name: param_name
    type: string       # string | number | boolean | cron
    default: value
    required: false

env:
  - SECRET_NAME        # injected from secrets store

timeout: 60s

notify:
  on_success: false
  on_failure: true

security:
  allowed_tasks: ["*"]
  allowed_mcp: ["*"]
```

### Deno shim globals (available in task.ts)

```typescript
log.info(msg)          // structured logging
log.error(msg)
params.get("name")     // task params
kv.get/set/delete      // persistent KV store
input                  // chain input payload
output(value)          // set return value
dicode.run_task(id, params)   // invoke another task (issue #24)
dicode.list_tasks()           // enumerate registered tasks
dicode.get_config("ai")       // resolve AI config (key resolved server-side)
http.register("GET /*", handler)  // register HTTP route (webui uses this)
mcp.list_tools(name)          // MCP server tools (issue #26)
mcp.call(name, tool, args)
```

## webui task (issue #58)

Replace `pkg/webui/` Go HTTP server with a Deno daemon task.

- Registers `GET /*` via `http.register` (daemon's HTTP gateway proxies to it over IPC)
- Serves the existing SPA from `examples/webui/app/` (ported here)
- WebSocket live log streaming
- REST API passthrough to daemon over IPC
- Auth overlay (`dc-auth-overlay`)
- AI chat sidebar (SSE stream)

**What gets deleted from dicode-core:** `pkg/webui/`, `static/` embedded assets, `webui.New(...)` in `cmd/dicoded/main.go`.

## notify task (issue #60)

Replace SW-based browser notifications with native OS desktop notifications.

- Uses [`deno_notify`](https://github.com/Pandawan/deno_notify) for macOS/Windows/Linux toasts
- Receives event via chain or webhook
- Parses `{ title, body, priority, tags }` from input
- Called as `on_failure_chain` or `on_success_chain` from other tasks
- Remove `examples/webui/sw.js` SW notification code (keep in-page inbox panel `dc-notif-panel.js`)

## tray task (issue #59)

Replace `pkg/tray/` CGO dependency with a Deno daemon task.

- Option A (preferred): `deno.land/x/systray` — pre-compiled native helper over stdin/stdout
- Menu items: Open Dashboard, Quit
- Requires `deno.run` capability flag in task spec

**What gets deleted from dicode-core:** `pkg/tray/`, tray startup in `cmd/dicoded/main.go`, CGO build requirement.

## TaskSet manifest

`taskset.yaml` at repo root composes all built-in tasks:

```yaml
apiVersion: dicode/v1
kind: TaskSet
name: dicode-builtin
tasks:
  - path: ./webui
  - path: ./notify
  - path: ./tray
```

## How dicoded auto-loads this repo

`dicoded` adds `dicode-builtin` as a default source on first start (git source pointing to this repo). Tasks are hot-reloaded via the reconciler (30s polling or git push webhook).

## Development workflow

1. Run `dicoded` from `/home/dr14/dicode/` with a local source pointing to this repo
2. Edit tasks here; reconciler picks up changes automatically
3. Test with `deno test` or via `dicode run <task-id>`
4. E2E tests live in `/home/dr14/dicode/tests/e2e/`

## Related issues in dicode-core

- #58 WebUI as built-in daemon task (primary)
- #59 System tray migration (CGO removal)
- #60 deno_notify replacement for SW notifications
- #24 `dicode` shim global (prerequisite for task orchestration)
- #25 `on_failure_chain` config default (notify task hooks into this)
- #48 (done) HTTP gateway IPC — foundation for `http.register`
