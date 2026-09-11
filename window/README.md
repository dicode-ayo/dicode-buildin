# `buildin/window`

Opens another task's own webhook UI in a chrome-less native window, then exits.

```bash
dicode run buildin/window target=prs width=480 height=600 alignment=center
```

The window renders `/hooks/<target>` — the target's existing UI, gated by its own
`trigger.auth`. A task that wants a window ships an `index.html`; this supplies the frame.
There is no new page anywhere, and nothing about the window is dicode's to manage after
launch: closing it is a browser event dicode never sees.

## Composing a windowed app

There is no per-app task to write. Bind the run itself:

```
bindsym $mod+Shift+g exec --no-startup-id dicode run buildin/window target=prs width=480 height=600
```

An operator who wants a named `prs-window` task adds an entry to a taskset of their own that
refs this `task.yaml` and bakes the params in as `overrides.params`, the way `taskset.yaml`
layers `dicodai` onto `ai-agent` here. That needs the entry's `ref.path` to reach this
directory, so it only applies to a taskset that has it on disk.

## Window manager rules

The run returns (and logs) the i3 rule for the `WM_CLASS` instance it just produced. Paste
it into your config once per windowed app:

```
for_window [instance="localhost__hooks_prs"] floating enable, border none, resize set 480 600, move position center
```

Rules key on the **instance**, never the class. `--class`, `--window-size` and
`--window-position` bind to the browser process rather than the window, and every windowed
task shares one process — so from the second launch on they are dropped, and a window
asking for them comes up carrying the first launch's values. The instance is a property of
the URL, needs no cooperation from the target, and does not change with the daemon's port.

picom rules key on the same instance, if you want translucency:

```
opacity-rule = [ "92:class_i = 'localhost__hooks_prs'" ];
```

## What it refuses

A target that is not registered, a bare name two tasks answer to, and a target with **no
webhook trigger**. That last one is a proxy, not a UI check: `list_tasks` withholds the task
directory, and a GET to the hook path to look for an `index.html` would fire the task rather
than answer the question. A webhook task that serves JSON and ships no `index.html` still
gets a window.

## Host requirements

Linux and X11. `host` selects from a closed table — `chrome`, `chromium`, `brave`, `edge`.
The table is what bounds which binaries can be launched: the host runs behind
`setsid --fork`, and `setsid` execs whatever it is handed, so Deno's `--allow-run` only ever
sees `setsid` and cannot narrow anything.

The double fork is required because Deno kills a spawned child when the run exits. Without
it the first launch opens a window and loses it a moment later, while every launch after
that survives by handing off to the browser the first one was meant to have left running.

`DISPLAY` and `XAUTHORITY` are declared in `permissions.env` because the daemon forwards
only its own allowlist to a task subprocess (`pkg/runtime/subprocenv.go`) and neither is on
it. Without them the browser has no X server and exits immediately — silently, since the
spawn is detached.

`port` is a param rather than an env read: no `DICODE_PORT` exists, so a daemon on a
non-default `server.port` has to repeat it here.

All windowed tasks share one browser profile under the dicode data dir, so the device cookie
lives in one jar: log in once with *trust this browser* ticked and every later window opens
silently. Per-task profiles would mean a login per app.
