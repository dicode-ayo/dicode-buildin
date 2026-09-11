// window/task.ts — open another task's webhook UI in a chrome-less window.
//
// The whole task is: resolve the target's hook URL, reject a target with no
// UI, build the host argv, spawn detached, exit. Everything below the handler
// is pure so the argv, the WM_CLASS instance and the stdio shape are testable
// without a browser or a daemon.

import type { DicodeSdk } from "../sdk.ts";

export interface TaskSummary {
  id: string;
  name?: string;
  webhook?: string;
}

export interface WindowSettings {
  width: string;
  height: string;
  alignment: string;
  opacity: string;
  sticky: boolean;
}

// ── target resolution ────────────────────────────────────────────────────────

/**
 * Find the task `target` names and return its webhook path.
 *
 * Accepts a namespaced id (`buildin/webui`) or the bare trailing segment when
 * exactly one task carries it. Throws naming the target when it does not
 * exist, is ambiguous, or has no webhook trigger — a task reachable only by
 * cron or a manual run has no UI to frame.
 */
export function resolveTarget(tasks: TaskSummary[], target: string): string {
  const wanted = target.trim();
  if (wanted === "") throw new Error("window: params.target is empty");

  let match = tasks.find((t) => t.id === wanted);
  if (!match) {
    const bare = tasks.filter((t) => t.id.split("/").pop() === wanted);
    if (bare.length > 1) {
      const ids = bare.map((t) => t.id).sort().join(", ");
      throw new Error(
        `window: "${wanted}" is ambiguous — name one of: ${ids}`,
      );
    }
    match = bare[0];
  }
  if (!match) {
    throw new Error(`window: no task named "${wanted}" is registered`);
  }
  if (!match.webhook || match.webhook.trim() === "") {
    throw new Error(
      `window: task "${match.id}" has no webhook trigger, so it serves no UI to open`,
    );
  }
  return match.webhook.trim();
}

/**
 * Absolute URL for a webhook path. The daemon routes the declared path
 * verbatim (trailing slash trimmed), so this does not assume a /hooks prefix.
 */
export function hookURL(webhook: string, port: number): string {
  let path = webhook.replace(/\/+$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  return `http://localhost:${port}${path}`;
}

// ── window identity ──────────────────────────────────────────────────────────

// Characters Chromium's path sanitizer replaces before the app name becomes a
// WM_CLASS. Kept in step with GetWMClassFromAppName, which runs the name
// through ReplaceIllegalCharactersInPath and then trims underscores. The
// control characters that sanitizer also covers cannot reach here: the URL
// parser percent-encodes them out of the pathname first.
const ILLEGAL_IN_PATH = /[\\/:*?"<>|]/g;

/**
 * The WM_CLASS instance Chromium will give the window.
 *
 * --class is a process-startup flag: because every windowed task shares one
 * browser process, a second launch has it silently ignored. The instance is
 * derived from the URL instead and is stable, which is why every emitted WM
 * rule keys on it rather than on the class.
 */
export function wmInstance(url: string): string {
  const u = new URL(url);
  // Chromium's GenerateApplicationNameFromURL: host, "_", path. The port is
  // not part of it, so moving the daemon's port leaves WM rules working.
  const appName = `${u.hostname}_${u.pathname}`;
  return appName.replace(ILLEGAL_IN_PATH, "_").replace(/^_+|_+$/g, "");
}

// ── host argv ────────────────────────────────────────────────────────────────

// Deno kills a spawned child when the run exits, so the host is launched
// through a double fork that reparents it away. A second launch survives
// without this only because it hands off to the browser the first one left
// running — which is exactly the launch this protects.
export const DETACH_BINARY = "setsid";

/**
 * Argv for the detaching launcher: the host binary and its flags behind a
 * `setsid --fork`.
 *
 * Geometry is deliberately absent: --window-size and --window-position are
 * startup flags too, so they would apply to the first window of a browser
 * session and be dropped for every one after it. WM rules place the window
 * instead.
 */
export function buildArgv(
  hostBinary: string,
  url: string,
  profileDir: string,
): string[] {
  return [
    "--fork",
    hostBinary,
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

/**
 * Spawn options for the host.
 *
 * All three streams MUST stay "null". The Deno runtime reads task output
 * through a pipe and does not return from a run until the log scanners see
 * EOF; a browser that inherited that pipe holds its write end open for as long
 * as the window lives, so the run hangs forever while the window works and
 * everything looks fine. The window outlives the run, so the pipe has to be
 * detached at spawn rather than closed afterwards.
 */
export function spawnOptions(args: string[]): Deno.CommandOptions {
  return { args, stdin: "null", stdout: "null", stderr: "null" };
}

// ── window manager rules ─────────────────────────────────────────────────────

/**
 * The i3 and picom rules for this instance, in the order a user pastes them.
 * i3 owns decoration and geometry; picom owns translucency.
 */
export function wmRules(instance: string, s: WindowSettings): string[] {
  const actions = ["floating enable", "border none"];
  if (s.sticky) actions.push("sticky enable");
  if (s.width !== "" && s.height !== "") {
    actions.push(`resize set ${s.width} ${s.height}`);
  }
  if (s.alignment === "center") actions.push("move position center");

  const rules = [`for_window [instance="${instance}"] ${actions.join(", ")}`];
  if (s.opacity !== "") {
    rules.push(`opacity-rule = [ "${s.opacity}:class_i = '${instance}'" ];`);
  }
  return rules;
}

// ── handler ──────────────────────────────────────────────────────────────────

export default async function main({ params, dicode }: DicodeSdk) {
  const target = (await params.get("target")) ?? "";
  const hostBinary = (await params.get("host_binary")) ?? "google-chrome";

  const tasks = (await dicode.list_tasks()) as TaskSummary[];
  const webhook = resolveTarget(tasks ?? [], target);

  const port = parseInt((await params.get("port")) || "8080", 10);
  const url = hookURL(webhook, port);
  const instance = wmInstance(url);

  const dataDir = Deno.env.get("DICODE_DATADIR") ??
    `${Deno.env.get("HOME") ?? "."}/.cache/dicode`;
  const profileDir = (await params.get("profile_dir")) ||
    `${dataDir}/window-profile`;

  const args = buildArgv(hostBinary, url, profileDir);
  const child = new Deno.Command(DETACH_BINARY, spawnOptions(args)).spawn();
  // setsid exits the moment it has forked, so there is nothing here worth
  // awaiting — and awaiting the browser itself would only return when the
  // user closes the window.
  child.unref();

  const settings: WindowSettings = {
    width: (await params.get("width")) ?? "",
    height: (await params.get("height")) ?? "",
    alignment: (await params.get("alignment")) ?? "",
    opacity: (await params.get("opacity")) ?? "",
    sticky: ((await params.get("sticky")) ?? "false") === "true",
  };
  const rules = wmRules(instance, settings);

  // One write, not four: the handler returns within milliseconds of the spawn
  // and the runtime's log scanners lose whatever is still unflushed when the
  // process exits. The return value carries the same rules for anything
  // reading the run result rather than the log.
  console.log([
    `window: opened ${url} (${hostBinary})`,
    `window: WM_CLASS instance ${instance}`,
    ...rules.map((rule) => `window: ${rule}`),
  ].join("\n"));

  return { url, instance, host: hostBinary, rules };
}
