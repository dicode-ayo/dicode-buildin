# `buildin/window`

Opens another task's own webhook UI in a chrome-less native window, then exits.

```bash
dicode run buildin/window target=prs width=480 height=600 alignment=center
```

The window renders `/hooks/<target>` — the target's existing UI, gated by its own
`trigger.auth`. A task that wants a window ships an `index.html`; this supplies the frame.
There is no new page anywhere, and nothing about the window is dicode's to manage after
launch: closing it is a browser event dicode never sees.

## Window manager rules

The run returns (and logs) the i3 and picom rules for the `WM_CLASS` instance it just
produced. Paste them into your config once per windowed app:

```
for_window [instance="localhost__hooks_prs"] floating enable, border none, resize set 480 600, move position center
opacity-rule = [ "92:class_i = 'localhost__hooks_prs'" ];
```

Rules key on the **instance**, never the class. `--class`, `--window-size` and
`--window-position` are process-startup flags, and every windowed task shares one browser
process — so from the second launch on they are silently ignored, and a window asking for
them comes up carrying the first launch's values. The instance is derived from the URL,
needs no cooperation from the target, and does not change with the daemon's port.

Bind it like anything else:

```
bindsym $mod+Shift+g exec --no-startup-id dicode run buildin/window target=prs
```

## Authentication

All windowed tasks share one browser profile under the dicode data dir, so the device
cookie lives in one jar: log in once with *trust this browser* ticked and every later
window opens silently. Per-task profiles would mean a login per app.

## Host requirements

Linux and X11. The host is launched through `setsid --fork` because Deno kills a spawned
child when the run exits — without the double fork the very first launch opens a window and
loses it a moment later, while every launch after it survives by handing off to the browser
that first one was supposed to have left running.

`DISPLAY` and `XAUTHORITY` are declared in `permissions.env` because the daemon forwards
only its own allowlist to a task subprocess (`pkg/runtime/subprocenv.go`) and neither is on
it. Without them the browser has no X server and exits immediately — silently, since the
spawn is detached.

`port` is a param rather than an env read: no `DICODE_PORT` exists, so a daemon on a
non-default `server.port` has to repeat it here.
