import { Notification } from "https://deno.land/x/deno_notify/mod.ts";

// ── params ────────────────────────────────────────────────────────────────────

const title    = await params.get("title")    as string;
const body     = await params.get("body")     as string;
const priority = await params.get("priority") as string ?? "default";
const tagsRaw  = await params.get("tags")     as string ?? "";

if (!title) throw new Error("param 'title' is required");
if (!body)  throw new Error("param 'body' is required");

// ── urgency mapping ───────────────────────────────────────────────────────────
// deno_notify supports urgency levels on Linux (libnotify); map dicode priority
// values to the library's urgency strings.
//   min | low → low
//   default   → normal
//   high      → critical
//   urgent    → critical

type Urgency = "low" | "normal" | "critical";

function toUrgency(p: string): Urgency {
  switch (p) {
    case "min":
    case "low":
      return "low";
    case "high":
    case "urgent":
      return "critical";
    default:
      return "normal";
  }
}

// ── build subtitle / subtitle from tags ──────────────────────────────────────

const tags = tagsRaw
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// Prepend any tags as a bracketed prefix on the body so they surface on
// platforms where urgency / subtitle fields are unavailable.
const displayBody = tags.length > 0
  ? `[${tags.join(", ")}] ${body}`
  : body;

// ── deliver notification ──────────────────────────────────────────────────────

const urgency = toUrgency(priority);

const notif = new Notification()
  .title(title)
  .body(displayBody)
  .urgency(urgency);

notif.show();

await log.info("notification dispatched", { title, priority, urgency, tags });
