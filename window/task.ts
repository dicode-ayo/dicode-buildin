// window/task.ts — open another task's webhook UI in a chrome-less window.

import type { DicodeSdk } from "../sdk.ts";

export interface TaskSummary {
  id: string;
  name?: string;
  webhook?: string;
}

export interface WindowSettings {
  width: number;
  height: number;
  alignment: string;
}

/** Spawn seam: the call site's contract is a command plus its options. */
export type Spawn = (command: string, options: Deno.CommandOptions) => void;

// ── hosts ────────────────────────────────────────────────────────────────────

// A host's whole interface is turning a URL into an argv, so it is a table and
// not an abstraction layer. Every entry is Chromium-family and takes the same
// flags; the binary is what varies.
export const HOSTS: Record<string, string> = {
  brave: "brave-browser",
  chrome: "google-chrome",
  chromium: "chromium",
  edge: "microsoft-edge",
};

/**
 * Binary for a host name.
 *
 * The set is closed because `setsid` will exec whatever it is handed, so this
 * is where the range of launchable binaries is actually bounded — Deno's
 * --allow-run only ever sees `setsid`.
 */
export function resolveHost(name: string): string {
  const binary = HOSTS[name];
  if (!binary) {
    const known = Object.keys(HOSTS).join(", ");
    throw new Error(`window: unknown host "${name}" — one of: ${known}`);
  }
  return binary;
}

// ── target resolution ────────────────────────────────────────────────────────

/**
 * Find the task `target` names and return its webhook path.
 *
 * Accepts a namespaced id (`buildin/webui`) or the bare trailing segment when
 * exactly one task carries it. Throws naming the target when it does not
 * exist, is ambiguous, or has no webhook trigger.
 *
 * A webhook trigger is the closest test available: `list_tasks` withholds the
 * task directory, and a GET to the hook path to look for an index.html would
 * fire the task instead of answering the question.
 */
export function resolveTarget(tasks: TaskSummary[], target: string): string {
  const wanted = target.trim();
  if (wanted === "") throw new Error("window: params.target is empty");

  let match = tasks.find((t) => t.id === wanted);
  if (!match) {
    const bare = tasks.filter((t) => t.id.split("/").pop() === wanted);
    if (bare.length > 1) {
      const ids = bare.map((t) => t.id).sort().join(", ");
      throw new Error(`window: "${wanted}" is ambiguous — name one of: ${ids}`);
    }
    match = bare[0];
  }
  if (!match) {
    throw new Error(`window: no task named "${wanted}" is registered`);
  }
  if (!match.webhook || match.webhook.trim() === "") {
    throw new Error(
      `window: task "${match.id}" has no webhook trigger, so it serves nothing to open`,
    );
  }
  return match.webhook.trim();
}

/**
 * Absolute URL for a webhook path. The daemon routes a declared path verbatim
 * with its trailing slash trimmed, and does not impose a /hooks prefix.
 */
export function hookURL(webhook: string, port: number): string {
  let path = webhook.replace(/\/+$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  return `http://localhost:${port}${path}`;
}

// ── window identity ──────────────────────────────────────────────────────────

// Characters Chromium's GetWMClassFromAppName replaces before the app name
// becomes a WM_CLASS. The control characters it also covers cannot reach here:
// the URL parser percent-encodes them out of the pathname first.
const ILLEGAL_IN_PATH = /[\\/:*?"<>|]/g;

/**
 * The WM_CLASS instance Chromium gives the window.
 *
 * --class binds to the browser process, and a shared process means a second
 * launch never sees it. The instance is a property of the URL, so it holds for
 * every launch and is what WM rules can key on.
 */
export function wmInstance(url: string): string {
  const u = new URL(url);
  // GenerateApplicationNameFromURL: host, "_", path. The port is not part of
  // it, so moving the daemon's port leaves WM rules working.
  const appName = `${u.hostname}_${u.pathname}`;
  return appName.replace(ILLEGAL_IN_PATH, "_").replace(/^_+|_+$/g, "");
}

// ── host argv ────────────────────────────────────────────────────────────────

// Deno kills a spawned child when the run exits, so the host is launched
// behind a double fork that reparents it away.
export const DETACH_BINARY = "setsid";

/**
 * Argv for the detaching launcher: the host binary and its flags behind a
 * `setsid --fork`.
 *
 * Carries no geometry: --window-size and --window-position bind to the browser
 * process the same way --class does, so a shared process drops them too. WM
 * rules place the window.
 */
export function buildArgv(
  binary: string,
  url: string,
  profileDir: string,
): string[] {
  return [
    "--fork",
    binary,
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

/**
 * Spawn options for the launcher.
 *
 * All three streams MUST stay "null". A stream inherited by the browser stays
 * open for the life of the window, and the Deno runtime's log scanners hold
 * the run open until they see EOF — so an inherited pipe hangs the run while
 * the window itself works.
 */
export function spawnOptions(args: string[]): Deno.CommandOptions {
  return { args, stdin: "null", stdout: "null", stderr: "null" };
}

// ── window manager rules ─────────────────────────────────────────────────────

/**
 * The i3 rules for this instance, in the order i3 applies them. Geometry and
 * decoration are the window manager's.
 */
export function wmRules(instance: string, settings: WindowSettings): string[] {
  const actions = ["floating enable", "border none"];
  // i3's `resize set` takes both dimensions; a half-formed action fails the
  // whole for_window line rather than just itself.
  if (settings.width > 0 && settings.height > 0) {
    actions.push(`resize set ${settings.width} ${settings.height}`);
  }
  if (settings.alignment === "center") actions.push("move position center");
  return [`for_window [instance="${instance}"] ${actions.join(", ")}`];
}

// ── handler ──────────────────────────────────────────────────────────────────

export async function run(
  { params, dicode }: DicodeSdk,
  spawn: Spawn,
): Promise<Record<string, unknown>> {
  const binary = resolveHost((await params.get("host")) || "chrome");

  const tasks = (await dicode.list_tasks()) as TaskSummary[];
  const webhook = resolveTarget(
    tasks ?? [],
    (await params.get("target")) ?? "",
  );

  const port = Number((await params.get("port")) || "8080");
  const url = hookURL(webhook, port);
  const instance = wmInstance(url);

  // One shared profile: the device cookie lives in its jar, so a per-task
  // profile would cost a login per app.
  const dataDir = Deno.env.get("DICODE_DATADIR") ??
    `${Deno.env.get("HOME") ?? "."}/.cache/dicode`;
  const profileDir = `${dataDir}/window-profile`;

  spawn(DETACH_BINARY, spawnOptions(buildArgv(binary, url, profileDir)));

  const rules = wmRules(instance, {
    width: Number((await params.get("width")) || "0"),
    height: Number((await params.get("height")) || "0"),
    alignment: (await params.get("alignment")) ?? "",
  });

  // A single write: the handler returns within milliseconds of the spawn, and
  // output still buffered at exit never reaches the run log.
  console.log([
    `window: opened ${url} (${binary})`,
    `window: WM_CLASS instance ${instance}`,
    ...rules.map((rule) => `window: ${rule}`),
  ].join("\n"));

  return { url, instance, host: binary, rules };
}

const spawnDetached: Spawn = (command, options) => {
  new Deno.Command(command, options).spawn().unref();
};

export default function main(ctx: DicodeSdk): Promise<Record<string, unknown>> {
  return run(ctx, spawnDetached);
}
