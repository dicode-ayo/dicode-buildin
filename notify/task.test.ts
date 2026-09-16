/**
 * task.test.ts — unit tests for the notify task's failure-message mapping.
 *
 * Run with:
 *   deno test --allow-all --config=deno.json ./notify/task.test.ts
 * or:
 *   make test-tasks
 */
import { setupHarness } from "../sdk-test.ts";
await setupHarness(import.meta.url);

import { isNoNotificationServer, notifyFailureMessage } from "./failure.ts";
import { toWinIcon, windowsNotifyCommand } from "./windows.ts";

const SERVICE_UNKNOWN =
  "GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name " +
  "org.freedesktop.Notifications was not provided by any .service files";

test("isNoNotificationServer: true for a GDBus ServiceUnknown on Notifications", () => {
  assert.ok(isNoNotificationServer(SERVICE_UNKNOWN));
});

test("isNoNotificationServer: false for unrelated failures", () => {
  assert.equal(isNoNotificationServer("some other error"), false);
  assert.equal(
    isNoNotificationServer("org.freedesktop.Notifications delivered ok"),
    false,
  );
});

test("notifyFailureMessage: missing server → hint names dunst/mako + README", () => {
  const m = notifyFailureMessage(1, SERVICE_UNKNOWN);
  assert.ok(m.includes("dunst"), "should mention dunst");
  assert.ok(m.includes("mako"), "should mention mako");
  assert.ok(m.includes("README.md"), "should point at the README");
});

test("notifyFailureMessage: other failures pass through with the exit code", () => {
  const m = notifyFailureMessage(2, "boom");
  assert.ok(m.includes("exit 2"));
  assert.ok(m.includes("boom"));
});

// The Windows branch has never run on a Windows host. These pin the parts a
// balloon appearing on screen would not show: that both assemblies are loaded
// before SystemIcons is read, and that a quote in user text cannot terminate
// the PowerShell string it sits in.
test("windowsNotifyCommand: loads System.Drawing before reading SystemIcons", () => {
  const ps = windowsNotifyCommand("t", "b", "normal").at(-1)!;
  const drawing = ps.indexOf("Add-Type -AssemblyName System.Drawing;");
  const icons = ps.indexOf("[System.Drawing.SystemIcons]");
  assert.ok(drawing !== -1);
  assert.ok(drawing < icons);
});

test("windowsNotifyCommand: doubles single quotes in title and body", () => {
  const ps = windowsNotifyCommand("it's", "o'clock", "normal").at(-1)!;
  assert.ok(ps.includes("'it''s'"));
  assert.ok(ps.includes("'o''clock'"));
});

test("windowsNotifyCommand: spawns powershell without a profile", () => {
  const cmd = windowsNotifyCommand("t", "b", "low");
  assert.equal(cmd[0], "powershell");
  assert.ok(cmd.includes("-NoProfile"));
});

test("toWinIcon maps urgency to the ToolTipIcon enum", () => {
  assert.equal(toWinIcon("low"), "None");
  assert.equal(toWinIcon("normal"), "Info");
  assert.equal(toWinIcon("critical"), "Warning");
});
