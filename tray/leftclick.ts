// leftclick.ts — what a click on the icon itself does.
//
// Reaching the task at all requires starting the helper with -activate, and
// that flag makes the tray advertise ItemIsMenu=false. A host that honors the
// hint then stops opening the menu on left click, so the choice is the
// operator's and the safe end of it is the one that changes nothing.

/** "menu" leaves the host's own left-click behavior alone; "dashboard" asks the
 *  helper for an activate event and opens the dashboard on it. */
export type LeftClick = "menu" | "dashboard";

/** Interpret the `left_click` param. Anything unrecognized — a typo, an empty
 *  string, an unset param — resolves to "menu", so a mistake costs the feature
 *  rather than the menu. */
export function parseLeftClick(raw: string | null | undefined): LeftClick {
  return raw?.trim().toLowerCase() === "dashboard" ? "dashboard" : "menu";
}

/** Arguments for the helper binary. The flag is opt-in upstream for the same
 *  reason it is opt-in here. */
export function helperArgs(mode: LeftClick): string[] {
  return mode === "dashboard" ? ["-activate"] : [];
}
