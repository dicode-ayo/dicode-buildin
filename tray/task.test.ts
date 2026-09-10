/**
 * task.test.ts — unit tests for the tray task's SNI visibility hint.
 *
 * Run with:
 *   deno test --allow-all --config=deno.json ./tray/task.test.ts
 * or:
 *   make test-tasks
 */
import { setupHarness } from "../sdk-test.ts";
await setupHarness(import.meta.url);

import {
  classifyGdbusFailure,
  parseHostRegistered,
  probeSNIHost,
  trayVisibilityHint,
} from "./sni.ts";

test("trayVisibilityHint: no hint on macOS/Windows (native tray)", () => {
  assert.equal(trayVisibilityHint("darwin", false), null);
  assert.equal(trayVisibilityHint("windows", false), null);
});

test("trayVisibilityHint: no hint on Linux when a host is registered", () => {
  assert.equal(trayVisibilityHint("linux", true), null);
});

test("trayVisibilityHint: no hint on Linux when the probe was inconclusive", () => {
  assert.equal(trayVisibilityHint("linux", "unknown"), null);
});

test("trayVisibilityHint: Linux + no host → actionable hint", () => {
  const h = trayVisibilityHint("linux", false);
  assert.ok(h, "expected a hint string");
  assert.ok(h!.includes("snixembed"), "hint should name a bridge");
  assert.ok(h!.includes("README.md"), "hint should point at the README");
});

test("trayVisibilityHint: an unreachable bus blames the env, not the bar", () => {
  const h = trayVisibilityHint("linux", "unreachable");
  assert.ok(h, "expected a hint string");
  assert.ok(
    h!.includes("DBUS_SESSION_BUS_ADDRESS"),
    "hint should name the missing variable",
  );
  assert.ok(
    !h!.includes("snixembed"),
    "an unreachable bus is no basis for telling the operator to run a bridge",
  );
});

test("parseHostRegistered: reads gdbus true/false, null on garbage", () => {
  assert.equal(parseHostRegistered("(<true>,)\n"), true);
  assert.equal(parseHostRegistered("(<false>,)\n"), false);
  assert.equal(parseHostRegistered("unexpected reply"), null);
});

test("classifyGdbusFailure: only ServiceUnknown reports on ownership", () => {
  assert.equal(
    classifyGdbusFailure(
      "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name " +
        "org.kde.StatusNotifierWatcher was not provided by any .service files",
    ).kind,
    "unowned",
  );
  // A bus that answers with any other error was reached, so it disproves
  // nothing about hosting — the distinction this whole module turns on.
  assert.equal(
    classifyGdbusFailure(
      "Error: GDBus.Error:org.freedesktop.DBus.Error.InvalidArgs: No such " +
        "property “IsStatusNotifierHostRegistered”",
    ).kind,
    "unknown",
  );
  assert.equal(
    classifyGdbusFailure(
      "Error: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: Rejected",
    ).kind,
    "unknown",
  );
});

test("classifyGdbusFailure: a connection failure carries no D-Bus error name", () => {
  assert.equal(
    classifyGdbusFailure(
      "Error connecting: Cannot autolaunch D-Bus without X11 $DISPLAY",
    ).kind,
    "unreachable",
  );
  assert.equal(
    classifyGdbusFailure(
      "Error connecting: Could not connect: No such file or directory",
    ).kind,
    "unreachable",
  );
});

test("probeSNIHost: a bus that errors is never a 'no host' verdict", async () => {
  assert.equal(
    await probeSNIHost(() => Promise.resolve({ kind: "unknown" as const })),
    "unknown",
  );
});

test("probeSNIHost: false only when the bus says nobody owns the name", async () => {
  assert.equal(
    await probeSNIHost(() => Promise.resolve({ kind: "unowned" as const })),
    false,
  );
});

test("probeSNIHost: unreachable bus never becomes a 'no host' verdict", async () => {
  assert.equal(
    await probeSNIHost(() => Promise.resolve({ kind: "unreachable" as const })),
    "unreachable",
  );
});

test("probeSNIHost: true when a watcher reports a host", async () => {
  assert.equal(
    await probeSNIHost(() =>
      Promise.resolve({ kind: "reply" as const, stdout: "(<true>,)" })
    ),
    true,
  );
});

test("probeSNIHost: unknown when the runner throws (tooling missing)", async () => {
  assert.equal(
    await probeSNIHost(() => Promise.reject(new Error("no gdbus"))),
    "unknown",
  );
});
