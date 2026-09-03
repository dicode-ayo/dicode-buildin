/**
 * tasks-with-tests.ts — prints the taskset entry ids whose task ships tests.
 *
 * Entry name and directory name are not interchangeable: `notifications` lives
 * in notify/, and dicodai / auto-fix / task-create-turn are all overrides
 * pointing at ai-agent/. So resolve each entry to its directory, keep the ones
 * holding a task.test.ts, and emit one entry per directory — otherwise the
 * four ai-agent entries would run the same suite four times.
 *
 *   deno run --allow-read scripts/tasks-with-tests.ts
 */
import { parse as parseYaml } from "jsr:@std/yaml@1";
import { dirname, resolve } from "jsr:@std/path@1";

// deno-lint-ignore no-explicit-any
const manifest: any = parseYaml(await Deno.readTextFile("taskset.yaml"));
const entries: Record<string, { ref?: { path?: string } }> =
  manifest.spec?.entries ?? {};

const seen = new Set<string>();
const ids: string[] = [];

for (const [name, entry] of Object.entries(entries)) {
  const path = entry?.ref?.path;
  if (!path) continue;
  const dir = resolve(dirname(path));
  if (seen.has(dir)) continue;
  try {
    const st = await Deno.stat(`${dir}/task.test.ts`);
    if (!st.isFile) continue;
  } catch {
    continue; // no sibling test file
  }
  seen.add(dir);
  ids.push(`buildin/${name}`);
}

console.log(ids.join("\n"));
