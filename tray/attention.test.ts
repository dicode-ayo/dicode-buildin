/**
 * attention.test.ts — unit tests for the tray's attention badge decision.
 *
 * Run with:
 *   deno test --allow-all --config=deno.json ./tray/attention.test.ts
 * or:
 *   make test-tasks
 */
import { setupHarness } from "../sdk-test.ts";
await setupHarness(import.meta.url);

import {
  ATTENTION_STATUSES,
  countAttention,
  looksDifferent,
  toRuns,
  trayLook,
} from "./attention.ts";

const ICONS = { plain: "PLAIN", badged: "BADGED" };

test("countAttention: only suspended runs call for a person", () => {
  assert.equal(
    countAttention([
      { status: "suspended" },
      { status: "running" },
      { status: "success" },
      { status: "suspended" },
    ]),
    2,
  );
});

test("countAttention: a failed run does not raise the badge", () => {
  // A terminal state never clears itself, so counting it would pin the dot on
  // forever — the property that makes the badge worth looking at.
  assert.equal(countAttention([{ status: "failure" }]), 0);
  assert.ok(!ATTENTION_STATUSES.has("failure"));
});

test("toRuns: survives whatever get_runs hands back", () => {
  assert.equal(toRuns([{ status: "suspended" }]), [{
    status: "suspended",
  }]);
  assert.equal(toRuns(null), []);
  assert.equal(toRuns("not an array"), []);
  assert.equal(toRuns([null, 42, {}, { status: 7 }]), []);
});

test("trayLook: no waiting runs leaves the plain icon", () => {
  const look = trayLook(0, ICONS);
  assert.equal(look.icon, "PLAIN");
  assert.ok(!look.tooltip.includes("waiting"));
});

test("trayLook: waiting runs badge the icon and say how many", () => {
  assert.equal(trayLook(1, ICONS).icon, "BADGED");
  assert.ok(trayLook(1, ICONS).tooltip.includes("1 run is"));
  assert.ok(trayLook(3, ICONS).tooltip.includes("3 runs are"));
});

test("looksDifferent: a redraw is skipped when nothing changed", () => {
  const look = trayLook(0, ICONS);
  assert.ok(looksDifferent(null, look), "first paint always draws");
  assert.ok(!looksDifferent(look, trayLook(0, ICONS)));
  assert.ok(looksDifferent(look, trayLook(1, ICONS)));
  // Same icon, different count — the tooltip still has to follow.
  assert.ok(looksDifferent(trayLook(1, ICONS), trayLook(2, ICONS)));
});
