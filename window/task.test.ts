/**
 * task.test.ts — unit tests for buildin/window.
 *
 * The task spawns a browser, so the parts worth testing are the pure ones it
 * spawns from: the WM_CLASS instance every emitted rule keys on, the argv, the
 * stdio shape, and the refusal to frame a task that serves no UI. The two
 * failure modes that would otherwise surface in production rather than in CI —
 * a run that hangs on an inherited pipe, and a rule set keyed on something
 * Chromium silently ignores — each get a regression test.
 */
import { setupHarness } from "../sdk-test.ts";
import {
  buildArgv,
  DETACH_BINARY,
  hookURL,
  resolveTarget,
  spawnOptions,
  type TaskSummary,
  type WindowSettings,
  wmInstance,
  wmRules,
} from "./task.ts";

await setupHarness(import.meta.url);

const TASKS: TaskSummary[] = [
  { id: "buildin/webui", name: "Web UI", webhook: "/hooks/webui" },
  { id: "buildin/ai-agent", name: "AI Agent", webhook: "/hooks/ai" },
  { id: "buildin/temp-cleanup", name: "Temp File Cleanup" },
  { id: "mine/webui", name: "My Web UI", webhook: "/hooks/mine-webui" },
];

function settings(over: Partial<WindowSettings> = {}): WindowSettings {
  return {
    width: "",
    height: "",
    alignment: "",
    opacity: "",
    sticky: false,
    ...over,
  };
}

// ── target resolution ────────────────────────────────────────────────────────

test("resolves a namespaced id to its webhook path", () => {
  assert.equal(resolveTarget(TASKS, "buildin/webui"), "/hooks/webui");
});

test("resolves a bare name when only one task carries it", () => {
  assert.equal(resolveTarget(TASKS, "ai-agent"), "/hooks/ai");
});

test("refuses a bare name two tasks answer to", async () => {
  await assert.throws(
    () => resolveTarget(TASKS, "webui"),
    /ambiguous.*buildin\/webui, mine\/webui/,
  );
});

test("refuses an unregistered target, naming it", async () => {
  await assert.throws(() => resolveTarget(TASKS, "nope"), /"nope"/);
});

test("refuses a target with no webhook trigger, naming it", async () => {
  // A cron-only task serves no UI; framing it would open an empty window.
  await assert.throws(
    () => resolveTarget(TASKS, "buildin/temp-cleanup"),
    /buildin\/temp-cleanup.*no webhook trigger/,
  );
});

test("main refuses a UI-less target before it reaches a spawn", async () => {
  // Reaching Deno.Command here would try to launch a real browser, so this
  // failing is itself the signal that the guard moved after the spawn.
  dicode.list_tasks = () => Promise.resolve(TASKS);
  params.set("target", "buildin/temp-cleanup");
  await assert.throws(() => runTask(), /no webhook trigger/);
});

// ── hook URL ─────────────────────────────────────────────────────────────────

test("builds the hook URL on the daemon's port", () => {
  assert.equal(
    hookURL("/hooks/webui", 8080),
    "http://localhost:8080/hooks/webui",
  );
});

test("normalizes a webhook path without a leading slash", () => {
  // The daemon routes the declared path verbatim, so this does not assume
  // /hooks — it only guarantees a path the URL parser accepts.
  assert.equal(hookURL("custom/ui", 9000), "http://localhost:9000/custom/ui");
});

test("drops a trailing slash, which the daemon trims at registration", () => {
  assert.equal(
    hookURL("/hooks/webui/", 8080),
    "http://localhost:8080/hooks/webui",
  );
});

// ── window identity ──────────────────────────────────────────────────────────

test("derives the WM_CLASS instance Chromium will use", () => {
  // Verified against a running daemon: host, "_", path, with every path
  // separator replaced — two underscores after the host, not one.
  assert.equal(
    wmInstance("http://localhost:8080/hooks/auth-providers"),
    "localhost__hooks_auth-providers",
  );
});

test("instance ignores the port, so moving the daemon keeps WM rules working", () => {
  assert.equal(
    wmInstance("http://localhost:9999/hooks/webui"),
    wmInstance("http://localhost:8080/hooks/webui"),
  );
});

test("instance flattens a nested hook path", () => {
  assert.equal(
    wmInstance("http://localhost:8080/hooks/ai/dicodai"),
    "localhost__hooks_ai_dicodai",
  );
});

test("instance trims the trailing separator of a root path", () => {
  assert.equal(wmInstance("http://localhost:8080/"), "localhost");
});

// ── host argv ────────────────────────────────────────────────────────────────

test("argv points the app window at the URL in its own profile", () => {
  assert.equal(
    buildArgv(
      "google-chrome",
      "http://localhost:8080/hooks/webui",
      "/data/prof",
    ),
    [
      "--fork",
      "google-chrome",
      "--app=http://localhost:8080/hooks/webui",
      "--user-data-dir=/data/prof",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  );
});

test("argv double-forks the host away from the run", () => {
  // Deno kills a spawned child when the run exits. Without the fork the very
  // first launch opens a window and loses it a moment later; every launch
  // after that survives on its own, because it hands off to the browser the
  // first one was supposed to have left running.
  const argv = buildArgv("chromium", "http://localhost:8080/hooks/webui", "/p");
  assert.equal(DETACH_BINARY, "setsid");
  assert.equal(argv[0], "--fork");
  assert.equal(argv[1], "chromium", "the host binary follows the fork flag");
});

test("argv carries no geometry or class flags", () => {
  // --class, --window-size and --window-position are process-startup flags.
  // Every windowed task shares one browser process, so from the second launch
  // on they are silently ignored — a window asking for them would come up
  // carrying the first launch's values. Geometry is the WM's; see wmRules.
  const argv = buildArgv(
    "google-chrome",
    "http://localhost:8080/hooks/webui",
    "/data/prof",
  );
  for (const flag of ["--class", "--window-size", "--window-position"]) {
    assert.ok(
      !argv.some((a) => a.startsWith(flag)),
      `argv carries ${flag}, which is ignored after the first launch: ${
        argv.join(" ")
      }`,
    );
  }
});

// ── stdio ────────────────────────────────────────────────────────────────────

test("spawn detaches all three streams", () => {
  // A browser that inherits the run's stdout pipe holds its write end open for
  // as long as the window is open, so the Deno runtime's log scanners never
  // see EOF and the run hangs indefinitely — while the window works and
  // everything looks fine. Every launch would leak a stuck run.
  const opts = spawnOptions(["--app=http://localhost:8080/hooks/webui"]);
  assert.equal(opts.stdin, "null", "stdin must be detached");
  assert.equal(opts.stdout, "null", "stdout must be detached");
  assert.equal(opts.stderr, "null", "stderr must be detached");
});

// ── window manager rules ─────────────────────────────────────────────────────

test("emits a bare floating rule when no geometry is asked for", () => {
  assert.equal(wmRules("localhost__hooks_webui", settings()), [
    `for_window [instance="localhost__hooks_webui"] floating enable, border none`,
  ]);
});

test("maps width and height to an i3 resize", () => {
  assert.equal(
    wmRules("app", settings({ width: "600", height: "500" })),
    [`for_window [instance="app"] floating enable, border none, resize set 600 500`],
  );
});

test("maps alignment center to i3's native placement", () => {
  assert.equal(
    wmRules("app", settings({ alignment: "center" })),
    [`for_window [instance="app"] floating enable, border none, move position center`],
  );
});

test("omits the resize when only one dimension is given", () => {
  // i3's `resize set` takes both; emitting a half-formed rule would make the
  // whole for_window line fail to parse rather than just that one action.
  assert.equal(
    wmRules("app", settings({ width: "600" })),
    [`for_window [instance="app"] floating enable, border none`],
  );
});

test("adds sticky only when asked", () => {
  assert.equal(
    wmRules("app", settings({ sticky: true })),
    [`for_window [instance="app"] floating enable, border none, sticky enable`],
  );
});

test("emits a picom rule keyed on the instance when opacity is set", () => {
  // class_i, never class: the class is shared by every window of the browser
  // process, so a rule keyed on it would dim the user's other windows too.
  const rules = wmRules("app", settings({ opacity: "92" }));
  assert.equal(rules[1], `opacity-rule = [ "92:class_i = 'app'" ];`);
});

test("emits no picom rule when opacity is unset", () => {
  assert.equal(wmRules("app", settings()).length, 1);
});

test("orders a full rule set the way i3 parses it", () => {
  assert.equal(
    wmRules(
      "localhost__hooks_prs",
      settings({
        width: "480",
        height: "600",
        alignment: "center",
        opacity: "92",
        sticky: true,
      }),
    ),
    [
      `for_window [instance="localhost__hooks_prs"] floating enable, border none, sticky enable, resize set 480 600, move position center`,
      `opacity-rule = [ "92:class_i = 'localhost__hooks_prs'" ];`,
    ],
  );
});
