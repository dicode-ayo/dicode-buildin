// attention.ts — decide whether the tray icon should carry a "needs you" dot.
//
// The daemon exposes no single "is anything waiting for me" query, so the count
// is assembled from the per-task run lists the SDK does offer. Everything that
// decides what the operator sees is pure and lives here; task.ts only fetches
// and applies.

/** The subset of a run record this module reads. `dicode.get_runs` is typed
 *  `unknown`, so nothing wider can be relied on. */
export interface RunLike {
  status: string;
}

/** Run statuses that mean a person, not the daemon, has to act next.
 *
 *  Only self-clearing states belong here. A suspended run stops being suspended
 *  the moment somebody answers it, so the dot clears itself. A failed run stays
 *  failed forever, so counting failures would pin the dot on until the row was
 *  deleted — a badge that never goes out is one nobody reads. */
export const ATTENTION_STATUSES: ReadonlySet<string> = new Set(["suspended"]);

/** Narrow an untyped `dicode.get_runs` reply to the records worth counting.
 *  Anything that isn't an array of objects carrying a string `status` is
 *  dropped rather than thrown on: a probe that cannot read the run list must
 *  leave the badge alone, not crash the tray. */
export function toRuns(value: unknown): RunLike[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const status = (row as Record<string, unknown>).status;
    return typeof status === "string" ? [{ status }] : [];
  });
}

/** How many runs are waiting on a human. */
export function countAttention(runs: readonly RunLike[]): number {
  return runs.filter((run) => ATTENTION_STATUSES.has(run.status)).length;
}

/** What the tray should show. */
export interface TrayLook {
  icon: string;
  tooltip: string;
}

export interface TrayIcons {
  plain: string;
  badged: string;
}

/** Pure: the icon and tooltip for a given number of waiting runs. */
export function trayLook(count: number, icons: TrayIcons): TrayLook {
  if (count <= 0) {
    return { icon: icons.plain, tooltip: "dicode — automation server" };
  }
  const subject = count === 1 ? "1 run is" : `${count} runs are`;
  return {
    icon: icons.badged,
    tooltip: `dicode — ${subject} waiting for input`,
  };
}

/** True when moving to `next` changes what the operator sees. The helper is
 *  told the menu on every poll otherwise, and each update redraws the icon. */
export function looksDifferent(
  current: TrayLook | null,
  next: TrayLook,
): boolean {
  return current === null ||
    current.icon !== next.icon ||
    current.tooltip !== next.tooltip;
}
