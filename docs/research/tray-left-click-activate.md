# Left-click activation for the dicode tray icon on Linux

> **Outcome: not implemented.** §5 option A below was built and verified working
> — a fork of `systray-portable` on `fyne.io/systray` v1.12.2, emitting
> `{"type": "activate"}` behind an opt-in `-activate` flag — then dropped rather
> than merged, to avoid owning a fork of the helper binary. The tray stays on
> upstream v0.2.0 and menu-only behavior; on an XEmbed-only bar a left click on
> the icon does nothing. Reopen this only with the maintenance cost in mind: the
> finding below is what makes it possible, not a plan anyone is following.

## The question

Can `buildin/tray` get a **left-click** action on its Linux system-tray icon — one
click on the icon opens the dashboard, without going through a menu item — on the
target desktop (i3 + polybar + `snixembed`), while keeping the dicode daemon
CGO-free?

## Verdict — yes, qualified

**`snixembed` delivers left click as an SNI `Activate` call. That is not the
blocker.** snixembed 0.3.3 (the exact version installed here) wires a left click on
its XEmbed proxy icon straight to `org.kde.StatusNotifierItem.Activate(0, 0)` and
never consults `ItemIsMenu`.

The blocker is the **helper binary**. `systray-portable` v0.2.0 is built against
`fyne.io/systray` **v1.10.0**, which exports the *unimplemented* SNI stub — every
`Activate` call is answered with `org.freedesktop.DBus.Error.UnknownMethod`.
Verified live against the running tray:

```
$ gdbus call --session --dest org.kde.StatusNotifierItem-2300990-1 \
    --object-path /StatusNotifierItem \
    --method org.kde.StatusNotifierItem.Activate 100 100
Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Unknown / invalid method
```

So today, on this desktop, **a left click on the icon does nothing at all** — it does
not open the menu. (snixembed pops the menu only on button 3. The premise that
left-click opens the menu is what happens on GNOME/KDE-style hosts, which *do* honor
`ItemIsMenu = true`; it is not what happens here.)

Upstream already fixed this. `fyne.io/systray` **v1.12.0** (2025-12-23) added
`SetOnTapped` / `SetOnSecondaryTapped`, implements `Activate`, and derives
`ItemIsMenu` from whether a tap handler is set. The current helper cannot be
persuaded to use it — its wire protocol has no spare message type and the fix is
compiled in — so this needs **a forked, rebuilt helper binary**. That fork is small
and was validated end to end while researching this (see §4).

---

## 1. What a left click invokes in the StatusNotifierItem spec

Source: <https://www.freedesktop.org/wiki/Specifications/StatusNotifierItem/StatusNotifierItem/>
(freedesktop wiki, last edited 2021-05-07).

The item object exports exactly four methods:

| Method | Spec wording |
|---|---|
| `org.freedesktop.StatusNotifierItem.ContextMenu(INT x, INT y)` | "Asks the status notifier item to show a context menu, this is typically a consequence of user input, such as mouse **right click** over the graphical representation of the item." |
| `org.freedesktop.StatusNotifierItem.Activate(INT x, INT y)` | "Asks the status notifier item for activation, this is typically a consequence of user input, such as mouse **left click** over the graphical representation of the item. The application will perform any task is considered appropriate as an activation request." |
| `org.freedesktop.StatusNotifierItem.SecondaryActivate(INT x, INT y)` | "Is to be considered a secondary and less important form of activation compared to Activate. This is typically a consequence of user input, such as mouse **middle click** …" |
| `org.freedesktop.StatusNotifierItem.Scroll(INT delta, STRING orientation)` | mouse wheel. |

So the answer to "which method does a left click invoke" is **`Activate`**.

**Host discretion.** The spec says "typically", never "must" — the mapping from
physical input to method is the visualization's choice. The one lever the *item* has
is a property:

> `org.freedesktop.StatusNotifierItem.ItemIsMenu`
> BOOL: The item only support the context menu, the visualization **should prefer
> showing the menu or sending `ContextMenu()` instead of `Activate()`**

`ItemIsMenu` is a "should", and hosts vary. Electron's own docs state the ambiguity
plainly: "the StatusNotifierItem spec does not specify which action would cause an
activation, for some environments it is left mouse click, but for some it might be
double left mouse click"
(<https://www.electronjs.org/docs/latest/api/tray>). The practical consequence is
that the item must implement `Activate` and set `ItemIsMenu` honestly; what a given
bar does with that is out of the item's hands.

## 2. What snixembed does on left click — it sends `Activate`

Installed here: `/usr/bin/snixembed`, `snixembed --version` → `version: 0.3.3`,
running as pid 2295468 and holding `org.kde.StatusNotifierWatcher` (so it is both the
watcher and the only SNI host on this session bus; `IsStatusNotifierHostRegistered` →
`true`).

Source: <https://git.sr.ht/~steef/snixembed>, tag 0.3.3.

`src/proxyicon.vala` builds one `Gtk.StatusIcon` per SNI item and wires it up:

```vala
33:  icon.activate.connect(() => item.activate(0, 0)); // TODO: consider smarter coordinate hints
34:  icon.button_press_event.connect(on_button_press);
...
39:  bool on_button_press(Gdk.EventButton event) {
40:      if (event.button == 3) {
41:          if (menu != null) {
42:              menu.popup_at_pointer(event);
43:              return true;
44:          }
46:          item.context_menu((int)event.x_root, (int)event.y_root);
47:          return true;
48:      }
49:      return false;
50:  }
```

`item.activate` is the Vala binding for `org.kde.StatusNotifierItem.Activate`, declared
in `src/statusnotifieritem.vala` as `public abstract void activate(int x, int y);`.

The chain for a left click is closed by GTK 3. `on_button_press` returns `false` for
any button other than 3, so GTK's own handler runs
(`gtk/deprecated/gtkstatusicon.c`, branch gtk-3-24, `gtk_status_icon_button_press`,
lines 1669–1692,
<https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gtk/deprecated/gtkstatusicon.c#L1669>):

```c
  g_signal_emit (status_icon, status_icon_signals [BUTTON_PRESS_EVENT_SIGNAL], 0, event, &handled);
  if (handled)
    return TRUE;

  if (gdk_event_triggers_context_menu ((GdkEvent *) event))
    { emit_popup_menu_signal (status_icon, event->button, event->time); return TRUE; }
  else if (event->button == GDK_BUTTON_PRIMARY && event->type == GDK_BUTTON_PRESS)
    { emit_activate_signal (status_icon); return TRUE; }
```

Primary button → `activate` signal → snixembed's lambda → D-Bus `Activate(0, 0)`.

Two things worth stating explicitly:

- **snixembed never reads `ItemIsMenu`.** There is no reference to it anywhere in the
  source tree. So the property that makes GNOME/KDE show the menu on left click is
  simply ignored here — snixembed always calls `Activate`.
- The README confirms the intent: under "Currently supported" it lists "**activation
  on left mouse button**" and "context menu on right mouse button (Menu dbusmenu or
  ContextMenu)".

**Conclusion for point 2: snixembed can and does deliver left click. This setup is
not the obstacle.**

## 3. The helper is the obstacle — and the library landscape

### What is actually running

The binary the task downloads and runs is fully self-describing:

```
$ go version -m /home/dr14/.cache/deno/https/github.com/dbcbcbf78…
  path    github.com/wobsoriano/systray-portable
  dep     fyne.io/systray  v1.10.0
  dep     github.com/godbus/dbus/v5  v5.1.0
  build   CGO_ENABLED=0
  build   GOOS=linux  GOARCH=amd64
  build   vcs.revision=60dce97051e4d891a84f8bfcf98ec9092d7abf59
```

Statically linked, `CGO_ENABLED=0`, pure-Go D-Bus. The CGO-free property the task
exists to preserve comes from `fyne.io/systray`'s pure-Go SNI backend, not from the
process boundary — worth knowing, because it means bumping that dependency is the
whole game.

### Why `Activate` fails

`fyne.io/systray` v1.10.0, `systray_unix.go:167`:

```go
err := notifier.ExportStatusNotifierItem(conn, path, &notifier.UnimplementedStatusNotifierItem{})
```

`internal/generated/notifier/status_notifier_item.go:217`:

```go
func (*UnimplementedStatusNotifierItem) Activate(x int32, y int32) (err *dbus.Error) {
	err = &dbus.ErrMsgUnknownMethod
	return
}
```

and `systray_unix.go:302` hardcodes `"ItemIsMenu": { Value: true, … }`.

Live confirmation on the running item (`org.kde.StatusNotifierItem-2300990-1`):
`Activate` → `UnknownMethod`, `SecondaryActivate` → `UnknownMethod`, `ItemIsMenu` →
`true`. Introspection shows all four methods advertised — the D-Bus interface is
exported, only the implementations are stubs.

### The upstream fix

`fyne.io/systray` v1.12.0 (tagged 2025-12-23; current v1.12.2, 2026-06-09) added tap
hooks in commit ca66a66d8, "Allow hooks to Tapped and TappedSecondary (#98)",
2025-06-03 — <https://github.com/fyne-io/systray/pull/98>.

- `systray.go:162` — `func SetOnTapped(f func())`, `:166` — `SetOnSecondaryTapped`.
- `systray_notifier_unix.go:15` — `Activate` calls `tappedLeft()` and returns nil;
  falls back to `ErrMsgUnknownMethod` only when no handler is registered.
  `ContextMenu` and `SecondaryActivate` both route to `tappedRight`.
- `systray_unix.go:197` — exports `newLeftRightNotifierItem()` instead of the stub.
- `systray_unix.go:381` — `"ItemIsMenu": { Value: tappedLeft == nil && tappedRight == nil }`,
  i.e. registering a tap handler automatically tells well-behaved hosts to stop
  preferring the menu.

Windows (`systray_windows.go:1132`) and macOS (`systray_darwin.go:174`) honor the same
`tappedLeft`/`tappedRight` hooks, so this is a cross-platform feature, not a Linux
patch.

### Candidate libraries

| Option | Left click / Activate? | CGO-free from daemon? | Maintained? |
|---|---|---|---|
| `fyne.io/systray` ≥ v1.12.0 | **Yes** — `SetOnTapped` | Yes; linux/windows cross-compile with `CGO_ENABLED=0` (verified). darwin needs cgo, as it always has | Yes — 366 stars, pushed 2026-08-14 |
| `wobsoriano/systray-portable` (in use, v0.2.0) | No — pinned to fyne v1.10.0 | Yes | **No** — last push 2023-10-20, 4 stars, 2 forks (rummik 2023-09, Endy3032 2023-03, both stale, neither adds Activate). Only release assets are v0.2.0 |
| `wobsoriano/deno-systray` (`deno.land/x/systray`, vendored in `tray/systray/mod.ts`) | No | Yes | No — last push 2023-10-28. Already vendored and Deno-2-patched locally, so upstream status is moot |
| `zaaack/node-systray` | No activate event in the protocol | Helper is `getlantern/systray` lineage — GTK + libappindicator, needs those at runtime; still no CGO in the daemon | Repo pushed 2026-05-28, but the protocol is the same clicked/ready pair |
| `felixhao28/node-systray` (systray2) | No | Same as above | Last push 2023-05-16 |
| `Deno.Tray` (Deno 2.9, `deno desktop`) | API has a `click` event, but see below | n/a | Yes |
| `tauri-apps/tray-icon` (Rust) | **No on Linux** | Rust toolchain, GTK/appindicator at runtime | Yes |

**On `Deno.Tray`** — tempting, and a dead end here for three independent reasons
(<https://docs.deno.com/runtime/desktop/tray_and_dock/>):

1. It requires Deno ≥ 2.9 and the `deno desktop` build command, which "compiles a
   Deno project into a self-contained desktop application … bundles your code, the
   Deno runtime, and a rendering backend" (webview or CEF) —
   <https://docs.deno.com/runtime/reference/cli/desktop/>. A dicode task is run with
   `deno run` under permission flags, not compiled into an app bundle.
2. dicode pins Deno 2.3.3 (`dicode-core/pkg/deno/version.go:4`).
3. Its Linux backend is "AppIndicator / KStatusNotifierItem". The Rust `tray-icon`
   crate that this lineage uses documents its click events as
   "**Linux: Unsupported.** The event is not emmited even though the icon is shown and
   will still show a context menu on right click" —
   <https://docs.rs/tray-icon/latest/tray_icon/enum.TrayIconEvent.html>. The Deno tray
   docs' "Click events" section makes no Linux carve-out, but the backend it names
   does. Even on a Deno new enough to have it, left click on Linux would very likely
   be silent.

The irony is that the pure-Go helper dicode already uses has *better* SNI coverage
than the mainstream Rust/GTK stacks — it just needs a version bump.

## 4. Can the current helper be kept? No — but the patch is three lines

The helper's wire protocol (`systray-portable/main.go`, and its README) is:

- **helper → task**: `{"type": "ready"}` and `{"type": "clicked", "item": …,
  "seq_id": …, "__id": …}`. That is all — `main.go` writes exactly two shapes, the
  literal ready line and a `ClickEvent` struct.
- **task → helper**: `update-item`, `update-menu`, `update-item-and-menu`, `exit`
  (the `switch action.Type` in `main.go`).

There is **no unused or reserved message type** in either direction, and no
passthrough or escape hatch. The `Activate` D-Bus method is not merely unrouted, it is
answered with an error by a compiled-in stub. A patched binary is required.

The patch is genuinely small. Verified in a scratch checkout (nothing in the repo was
modified):

1. `go get fyne.io/systray@v1.12.2` — the unmodified `main.go` still compiles against
   it; the `MenuItem` / `ClickedCh` API used by the wrapper is unchanged.
2. One line in `onReady`:
   ```go
   systray.SetOnTapped(func() { fmt.Println(`{"type": "activate"}`) })
   ```
3. Build with `CGO_ENABLED=0`.

Run against this session's live bus, the result is exactly what is needed:

```
-- ItemIsMenu --
(<false>,)
-- Activate --
()
-- helper stdout --
{"type": "ready"}
{"type": "activate"}
```

`ItemIsMenu` flipped to false on its own, `Activate` returned success instead of
`UnknownMethod`, and the helper emitted a new event line. Since §2 established that
snixembed issues precisely this `Activate` call on left click, the end-to-end path is
proven.

**Cross-compilation, `CGO_ENABLED=0`, go1.26.0, systray-portable + fyne v1.12.2:**

| Target | Result |
|---|---|
| linux/386, linux/amd64, linux/arm64 | OK |
| windows/386, windows/amd64 | OK |
| darwin/arm64, darwin/amd64 | **FAIL** — `undefined: setInternalLoop` (macOS path is cgo/Objective-C) |

darwin has always needed a Mac to build — the existing v0.2.0 release ships
`tray_darwin_arm64` and its `build.sh` has `darwin/amd64` commented out. So a fork
needs a `macos-latest` runner in its release workflow, or it reuses the existing
darwin asset and accepts that macOS keeps menu-only behavior for now.

**Latent bug found while reading the protocol** (unrelated to this question, worth
filing separately): the vendored wrapper sends `"update-menu-and-item"`
(`tray/systray/mod.ts`, `UpdateMenuAndItemAction`) while the helper switches on
`"update-item-and-menu"` (`main.go`). The task never sends that action today, so it
has never bitten.

## 5. Options, effort, and risk

The tray only just started working, so the ranking below weights "how easily can this
be reverted" as heavily as effort.

### A. Fork `systray-portable`, bump fyne, publish dicode-owned release binaries — **recommended**

Work:
- Fork to `dicode-ayo/systray-portable`; bump `go.mod` to `fyne.io/systray` v1.12.2;
  add `SetOnTapped` (and optionally `SetOnSecondaryTapped`) emitting
  `{"type":"activate"}` / `{"type":"secondary-activate"}`. **~1 h.**
- Release workflow: `ubuntu-latest` for the five linux/windows targets with
  `CGO_ENABLED=0`, `macos-latest` for `darwin/arm64`. **~2–3 h** (first-time CI).
- `tray/systray/mod.ts`: add `ActivateEvent` to the `Event` union, dispatch it in the
  `on("data")` handler, add an `onActivate()` wrapper next to `onClick()`, and make
  `DEFAULT_URL_BASE` (currently hardcoded at `mod.ts:17`) overridable via `Conf` so
  the release origin is configuration, not a code fork. **~1 h.**
- `tray/task.ts`: `systray.onActivate(() => openBrowser(dashboardURL))`; bump the
  `tray_version` param default; tests. **~1 h.**

**Total: about one day including review.**

Risk: **low–moderate, and cleanly reversible.** The download is keyed by URL in
`deno.land/x/cache`, so a new release URL creates a new cache entry and leaves the
working v0.2.0 binary untouched on disk — rollback is reverting the URL/version and
restarting the task. `task.yaml`'s `net` allowlist already covers `github.com` and the
`*.githubusercontent.com` asset hosts, so no permission change is needed. Supply chain
arguably improves: the binary moves from an unmaintained 4-star third-party repo to
one dicode controls.

The real risk is **behavioral, not technical**, and it needs a decision:

> Setting a tap handler flips `ItemIsMenu` to `false` for *every* host, not just
> snixembed. On GNOME (AppIndicator extension), KDE, and waybar — which do honor the
> property — left click currently opens the menu. After this change, left click opens
> the dashboard and the menu becomes right-click only.

That is arguably the better behavior and matches what most tray apps do, but it is a
visible change for users on full desktops. If that is unwanted, gate `SetOnTapped`
behind a task param (`left_click: activate | menu`, default `activate`) — the helper
can read it from the init menu JSON, and `ItemIsMenu` follows automatically.

### B. Upstream a PR to `wobsoriano/systray-portable`

Effort: ~1 h to write, unbounded to land. The repo has had no push since 2023-10-20
and one open issue. **Not viable as the primary plan**; worth opening as a courtesy
PR alongside option A.

### C. Drop the helper — speak SNI directly from Deno over D-Bus

The task would own its own `org.kde.StatusNotifierItem`, implementing `Activate`
itself, via a pure-JS D-Bus client (`npm:dbus-next`, <https://github.com/dbusjs/node-dbus-next>)
over the session bus's unix socket.

Effort: **3–5 days.** SNI is not just four methods — it is watcher registration,
re-registration when a host appears late, `com.canonical.dbusmenu` for the menu (a
substantially larger interface than SNI itself), ARGB32 pixmap marshalling, and the
property-change signal dance. And it is **Linux-only**: macOS and Windows would still
need the helper, so the task ends up maintaining two tray implementations.

Risk: **high.** This rewrites the part that only just started working. Not worth it
to gain one click.

### D. `Deno.Tray`

Non-starter — see §3. Blocked three ways over, and its Linux click support is very
likely absent anyway.

### E. Do nothing; document right-click

Zero effort, zero risk. The menu already works on right click, and "Open Dashboard" is
one item away. Legitimate if left-click activation is a nice-to-have.

---

### Recommendation

**Option A**, with the left-click behavior gated behind a task param so full-desktop
users are not surprised. It is a one-day change, the mechanism is proven end to end
against this exact desktop, the rollback is a version string, and it moves the helper
binary under dicode's control — which is worth doing on its own merits given upstream
has been dormant for nearly three years.

Do not touch the tray until there is an appetite for re-verifying it on at least i3 +
polybar + snixembed and one full desktop; the change is small but it replaces the
binary that the whole feature rests on.

## Sources

- StatusNotifierItem specification — <https://www.freedesktop.org/wiki/Specifications/StatusNotifierItem/StatusNotifierItem/>
- snixembed 0.3.3, `src/proxyicon.vala`, `src/statusnotifieritem.vala`, README — <https://git.sr.ht/~steef/snixembed>
- GTK 3 `gtk_status_icon_button_press` — <https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gtk/deprecated/gtkstatusicon.c#L1669>
- `fyne.io/systray` v1.10.0 and v1.12.2 sources (via `proxy.golang.org`) — <https://github.com/fyne-io/systray>
- `fyne.io/systray` PR #98, commit ca66a66d8 — <https://github.com/fyne-io/systray/pull/98>
- `wobsoriano/systray-portable` `main.go`, `build.sh`, README, releases — <https://github.com/wobsoriano/systray-portable>
- Deno tray and dock guide — <https://docs.deno.com/runtime/desktop/tray_and_dock/>
- `deno desktop` CLI reference — <https://docs.deno.com/runtime/reference/cli/desktop/>
- `tray_icon::TrayIconEvent` platform notes — <https://docs.rs/tray-icon/latest/tray_icon/enum.TrayIconEvent.html>
- Electron Tray `click` event, on SNI activation ambiguity — <https://www.electronjs.org/docs/latest/api/tray>
- `dbus-next` — <https://github.com/dbusjs/node-dbus-next>
