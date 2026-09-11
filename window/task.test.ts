/**
 * task.test.ts — unit tests for buildin/window.
 *
 * The task spawns a browser, so what is tested is the pure input to that
 * spawn: the WM_CLASS instance every emitted rule keys on, the per-host argv,
 * the options the spawn is actually called with, and the refusal to frame a
 * task with no webhook.
 */
import { setupHarness } from "../sdk-test.ts";
import {
  buildArgv,
  DETACH_BINARY,
  hookURL,
  HOSTS,
  resolveHost,
  resolveTarget,
  run,
  type Spawn,
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
  return { width: 0, height: 0, alignment: "", ...over };
}

// A recording spawn plus the context `run` reads, so the call site can be
// driven without launching anything.
interface SpawnCall {
  command: string;
  options: Deno.CommandOptions;
}

function harness(paramValues: Record<string, string> = {}) {
  const calls: SpawnCall[] = [];
  const spawn: Spawn = (command, options) => {
    calls.push({ command, options });
  };
  const ctx = {
    params: {
      get: (k: string) => Promise.resolve(paramValues[k] ?? null),
      all: () => Promise.resolve(paramValues),
    },
    dicode: { list_tasks: () => Promise.resolve(TASKS) },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { calls, spawn, ctx };
}

// ── host table ───────────────────────────────────────────────────────────────

test("every host resolves to its binary", () => {
  assert.equal(resolveHost("chrome"), "google-chrome");
  assert.equal(resolveHost("chromium"), "chromium");
  assert.equal(resolveHost("brave"), "brave-browser");
  assert.equal(resolveHost("edge"), "microsoft-edge");
});

test("an unknown host names the ones that exist", async () => {
  // setsid execs whatever it is handed and Deno only ever sees setsid, so the
  // closed table is the only thing bounding which binaries can be launched.
  await assert.throws(() => resolveHost("firefox"), /unknown host "firefox"/);
  await assert.throws(() => resolveHost("firefox"), /chrome/);
});

test("argv is built per host over the whole table", () => {
  for (const [name, binary] of Object.entries(HOSTS)) {
    assert.equal(
      buildArgv(binary, "http://localhost:8080/hooks/webui", "/data/prof"),
      [
        "--fork",
        binary,
        "--app=http://localhost:8080/hooks/webui",
        "--user-data-dir=/data/prof",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      `argv for host ${name}`,
    );
  }
});

test("argv double-forks the host away from the run", () => {
  // Deno kills a spawned child when the run exits. Without the fork the first
  // launch loses its window; later launches survive by handing off to the
  // browser the first was meant to have left running.
  const argv = buildArgv("chromium", "http://localhost:8080/hooks/webui", "/p");
  assert.equal(DETACH_BINARY, "setsid");
  assert.equal(argv[0], "--fork");
  assert.equal(argv[1], "chromium");
});

test("argv carries no geometry or class flags", () => {
  const argv = buildArgv("google-chrome", "http://localhost:8080/h", "/prof");
  for (const flag of ["--class", "--window-size", "--window-position"]) {
    assert.ok(
      !argv.some((a) => a.startsWith(flag)),
      `argv carries ${flag}, which a shared browser process drops: ${
        argv.join(" ")
      }`,
    );
  }
});

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
  await assert.throws(
    () => resolveTarget(TASKS, "buildin/temp-cleanup"),
    /buildin\/temp-cleanup.*no webhook trigger/,
  );
});

test("a target with no webhook never reaches the spawn", async () => {
  const { calls, spawn, ctx } = harness({ target: "buildin/temp-cleanup" });
  await assert.throws(() => run(ctx, spawn), /no webhook trigger/);
  assert.equal(calls.length, 0, "spawned despite refusing the target");
});

// ── hook URL ─────────────────────────────────────────────────────────────────

test("builds the hook URL on the daemon's port", () => {
  assert.equal(
    hookURL("/hooks/webui", 8080),
    "http://localhost:8080/hooks/webui",
  );
});

test("normalizes a webhook path without a leading slash", () => {
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

// ── stdio ────────────────────────────────────────────────────────────────────

test("spawn options detach all three streams", () => {
  const opts = spawnOptions(["--fork", "google-chrome"]);
  assert.equal(opts.stdin, "null");
  assert.equal(opts.stdout, "null");
  assert.equal(opts.stderr, "null");
});

test("the spawn the handler makes detaches all three streams", async () => {
  // A stream the browser inherits stays open for the life of the window, and
  // the runtime's log scanners hold the run open until they see EOF — so an
  // inherited pipe hangs the run while the window itself works. Asserting on
  // the helper alone would miss a call site that built its own options.
  const { calls, spawn, ctx } = harness({
    target: "buildin/webui",
    port: "8080",
  });
  await run(ctx, spawn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "setsid");
  assert.equal(calls[0].options.stdin, "null", "stdin must be detached");
  assert.equal(calls[0].options.stdout, "null", "stdout must be detached");
  assert.equal(calls[0].options.stderr, "null", "stderr must be detached");
});

test("the handler spawns the host the params chose", async () => {
  const { calls, spawn, ctx } = harness({
    target: "buildin/webui",
    host: "brave",
  });
  const result = await run(ctx, spawn);

  assert.equal(calls[0].options.args?.[1], "brave-browser");
  assert.equal(result.host, "brave-browser");
});

test("the handler points the window at the target's hook path", async () => {
  const { calls, spawn, ctx } = harness({ target: "ai-agent", port: "18099" });
  const result = await run(ctx, spawn);

  assert.equal(result.url, "http://localhost:18099/hooks/ai");
  assert.ok(
    calls[0].options.args?.includes("--app=http://localhost:18099/hooks/ai"),
  );
});

// ── window manager rules ─────────────────────────────────────────────────────

test("emits a bare floating rule when no geometry is asked for", () => {
  assert.equal(wmRules("localhost__hooks_webui", settings()), [
    `for_window [instance="localhost__hooks_webui"] floating enable, border none`,
  ]);
});

test("maps width and height to an i3 resize", () => {
  assert.equal(wmRules("app", settings({ width: 600, height: 500 })), [
    `for_window [instance="app"] floating enable, border none, resize set 600 500`,
  ]);
});

test("maps alignment center to i3's native placement", () => {
  assert.equal(wmRules("app", settings({ alignment: "center" })), [
    `for_window [instance="app"] floating enable, border none, move position center`,
  ]);
});

test("omits the resize when only one dimension is given", () => {
  assert.equal(wmRules("app", settings({ width: 600 })), [
    `for_window [instance="app"] floating enable, border none`,
  ]);
});

test("orders a full rule set the way i3 applies it", () => {
  assert.equal(
    wmRules(
      "localhost__hooks_prs",
      settings({ width: 480, height: 600, alignment: "center" }),
    ),
    [
      `for_window [instance="localhost__hooks_prs"] floating enable, border none, resize set 480 600, move position center`,
    ],
  );
});
