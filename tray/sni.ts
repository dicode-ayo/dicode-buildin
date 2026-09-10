// sni.ts — detect whether a Linux system-tray host will actually display the
// icon.
//
// Linux tray icons use the StatusNotifierItem (SNI) DBus protocol. The icon is
// only shown if a StatusNotifierHost (a compatible bar/tray) is registered on
// the session bus. On bare window managers (i3/dwm/bspwm/sway) none runs by
// default, so the icon is silently invisible with no error. macOS (Cocoa) and
// Windows (Win32) render the tray natively and never hit this path.

const WATCHERS = [
  "org.kde.StatusNotifierWatcher",
  "org.freedesktop.StatusNotifierWatcher",
];

/** What a single watcher probe established.
 *  - `reply`: the watcher answered; `stdout` carries its reply.
 *  - `unowned`: the bus answered that nobody owns this name.
 *  - `unknown`: the bus answered, but with an error that says nothing about
 *    who is hosting (a wrong property, a denied read).
 *  - `unreachable`: the session bus was never reached, so nothing is known. */
export type WatcherProbe =
  | { kind: "reply"; stdout: string }
  | { kind: "unowned" }
  | { kind: "unknown" }
  | { kind: "unreachable" };

/** The state of SNI hosting on the session bus.
 *  `"unreachable"` and `"unknown"` are both "cannot tell", kept apart because
 *  only the former names a cause the operator can act on. */
export type HostProbe = boolean | "unreachable" | "unknown";

/** Interpret a `gdbus call … IsStatusNotifierHostRegistered` reply
 *  (e.g. `(<true>,)`). Returns null when the reply can't be interpreted. */
export function parseHostRegistered(stdout: string): boolean | null {
  if (/\btrue\b/.test(stdout)) return true;
  if (/\bfalse\b/.test(stdout)) return false;
  return null;
}

/** Classify a failed `gdbus call` by how far it got.
 *
 *  gdbus prefixes a reply carrying a D-Bus error name with `GDBus.Error:`,
 *  which is proof the call reached the bus; a connection failure (no
 *  DBUS_SESSION_BUS_ADDRESS, autolaunch refused, socket missing) is reported
 *  without one. Of the errors the bus can return, only ServiceUnknown says
 *  anything about who owns the watcher name — InvalidArgs and AccessDenied
 *  leave hosting exactly as unknown as before the call. */
export function classifyGdbusFailure(stderr: string): WatcherProbe {
  if (!/GDBus\.Error:/.test(stderr)) return { kind: "unreachable" };
  return /ServiceUnknown|not provided by any \.service files/.test(stderr)
    ? { kind: "unowned" }
    : { kind: "unknown" };
}

/** Query one watcher's IsStatusNotifierHostRegistered via gdbus. */
async function gdbusRunner(dest: string): Promise<WatcherProbe> {
  const { code, stdout, stderr } = await new Deno.Command("gdbus", {
    args: [
      "call",
      "--session",
      "--dest",
      dest,
      "--object-path",
      "/StatusNotifierWatcher",
      "--method",
      "org.freedesktop.DBus.Properties.Get",
      dest,
      "IsStatusNotifierHostRegistered",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code === 0) {
    return { kind: "reply", stdout: new TextDecoder().decode(stdout) };
  }
  return classifyGdbusFailure(new TextDecoder().decode(stderr));
}

/** Best-effort: is an SNI host registered on the session bus?
 *  - true/false when a watcher answers definitively,
 *  - false when the bus confirms no watcher owns either name (a host is then
 *    impossible),
 *  - "unreachable" when the session bus was never reached, so the absence of a
 *    watcher proves nothing,
 *  - "unknown" when the tooling is unusable or a reply is unreadable,
 *  so callers can stay quiet instead of warning on a guess. */
export async function probeSNIHost(
  runner: (dest: string) => Promise<WatcherProbe> = gdbusRunner,
): Promise<HostProbe> {
  let reachedBus = false;
  // Set when the bus answered without settling the question. Only a bus that
  // answered every time, and every time said the name is unowned, is grounds
  // for concluding there is no host.
  let inconclusive = false;
  for (const dest of WATCHERS) {
    let probe: WatcherProbe;
    try {
      probe = await runner(dest);
    } catch {
      return "unknown"; // tooling unusable — don't nag
    }
    if (probe.kind === "unreachable") continue;
    reachedBus = true;
    if (probe.kind === "unowned") continue;
    if (probe.kind === "unknown") {
      inconclusive = true;
      continue;
    }
    const registered = parseHostRegistered(probe.stdout);
    if (registered !== null) return registered;
    inconclusive = true; // answered, but not in a shape we understand
  }
  if (inconclusive) return "unknown";
  return reachedBus ? false : "unreachable";
}

/** An actionable hint when the tray icon will likely be invisible, else null.
 *  Pure and synchronous so the decision is unit-testable. */
export function trayVisibilityHint(
  os: string,
  host: HostProbe,
): string | null {
  if (os !== "linux") return null; // macOS/Windows render natively
  if (host === "unreachable") {
    return (
      "tray: could not reach the session bus, so whether the icon will appear " +
      "is unknown. The probe needs DBUS_SESSION_BUS_ADDRESS (and " +
      "XDG_RUNTIME_DIR) in the task environment; declare them under " +
      "permissions.env. See ./tray/README.md."
    );
  }
  if (host !== false) return null; // true = shown; "unknown" = no basis to warn
  return (
    "tray: no StatusNotifierItem host is running on the session bus, so the " +
    "icon will not appear. Bare window managers (i3/dwm/bspwm/sway) don't host " +
    "SNI by default. On Wayland use waybar's tray module; on X11 run " +
    "`snixembed --fork` in front of your bar — i3bar and polybar render " +
    "only XEmbed. " +
    "See ./tray/README.md."
  );
}

/** Probe the bus and, on Linux with no host, log a single actionable hint. */
export async function warnIfTrayInvisible(
  log: (msg: string) => void = console.warn,
): Promise<void> {
  if (Deno.build.os !== "linux") return;
  const hint = trayVisibilityHint("linux", await probeSNIHost());
  if (hint) log(hint);
}
