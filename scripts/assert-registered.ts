/**
 * assert-registered.ts — every taskset.yaml entry reached the registry.
 *
 * A task.yaml the daemon's strict validator rejects never registers; it just
 * silently isn't there. No unit test can see that, so CI boots a daemon
 * against this repo and checks the manifest against what actually landed.
 *
 * Reads the registry over the REST API rather than `dicode list`, which omits
 * kind: PipelineTask entries.
 *
 *   deno run --allow-read --allow-net assert-registered.ts <base-url>
 */
import { parse as parseYaml } from "jsr:@std/yaml@1";

const baseUrl = Deno.args[0] ?? "http://127.0.0.1:18765";
const timeoutMs = 60_000;

// deno-lint-ignore no-explicit-any
const manifest: any = parseYaml(await Deno.readTextFile("taskset.yaml"));
const expected = Object.keys(manifest.spec?.entries ?? {})
  .map((name) => `buildin/${name}`)
  .sort();

if (expected.length === 0) {
  console.error("taskset.yaml declares no entries");
  Deno.exit(1);
}

async function registered(): Promise<Set<string>> {
  const res = await fetch(`${baseUrl}/api/tasks`);
  if (!res.ok) throw new Error(`GET /api/tasks: ${res.status}`);
  const body = await res.json();
  const tasks = Array.isArray(body) ? body : body.tasks ?? [];
  // deno-lint-ignore no-explicit-any
  return new Set(tasks.map((t: any) => t.id));
}

// A kind: PipelineTask entry retries until every stage task it names has
// registered, so it lands after the plain tasks do.
const deadline = Date.now() + timeoutMs;
let missing: string[] = [];
while (Date.now() < deadline) {
  try {
    const have = await registered();
    missing = expected.filter((id) => !have.has(id));
    if (missing.length === 0) {
      console.log(`all ${expected.length} taskset entries registered`);
      Deno.exit(0);
    }
  } catch (err) {
    missing = [`(registry unreachable: ${err instanceof Error ? err.message : err})`];
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.error(`::error::${missing.length} taskset entries never registered`);
for (const id of missing) console.error(`  missing: ${id}`);
Deno.exit(1);
