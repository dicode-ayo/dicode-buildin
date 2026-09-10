/**
 * leftclick.test.ts — unit tests for the tray's left-click mode.
 *
 * Run with:
 *   deno test --allow-all --config=deno.json ./tray/leftclick.test.ts
 * or:
 *   make test-tasks
 */
import { setupHarness } from "../sdk-test.ts";
await setupHarness(import.meta.url);

import { helperArgs, parseLeftClick } from "./leftclick.ts";

test("parseLeftClick: only an explicit dashboard opts in", () => {
  assert.equal(parseLeftClick("dashboard"), "dashboard");
  assert.equal(parseLeftClick(" Dashboard "), "dashboard");
  assert.equal(parseLeftClick("menu"), "menu");
});

test("parseLeftClick: anything unrecognized keeps the menu", () => {
  // Opting in costs the host's left-click menu, so a typo must not do it
  // silently — the same fail-closed rule the helper applies to its own flag.
  assert.equal(parseLeftClick("dashbord"), "menu");
  assert.equal(parseLeftClick(""), "menu");
  assert.equal(parseLeftClick(null), "menu");
  assert.equal(parseLeftClick(undefined), "menu");
});

test("helperArgs: the flag is passed only for dashboard", () => {
  assert.equal(helperArgs("dashboard"), ["-activate"]);
  assert.equal(helperArgs("menu"), []);
});
