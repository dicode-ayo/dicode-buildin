/**
 * assert-taskset.ts — what only a running daemon can tell us.
 *
 * Two classes of check, both needing the real resolver rather than the raw
 * YAML that taskset.test.ts reads:
 *
 *  1. Registration. A task.yaml the strict validator rejects never registers;
 *     it just silently isn't there. Compare the manifest against the registry.
 *
 *  2. Resolved-spec contracts. Overrides are merged and ${DATADIR} expanded by
 *     the daemon, so grants like write-task-file's write root only have their
 *     real value after resolution.
 *
 * The registry is read over the REST API rather than `dicode list`, which
 * omits kind: PipelineTask entries.
 *
 *   deno run --allow-read --allow-net assert-taskset.ts <base-url>
 */
import { parse as parseYaml } from "jsr:@std/yaml@1";

const baseUrl = Deno.args[0] ?? "http://127.0.0.1:18765";
const timeoutMs = 60_000;

// deno-lint-ignore no-explicit-any
type Json = any;

const failures: string[] = [];
function check(ok: boolean, msg: string) {
  if (!ok) failures.push(msg);
}

// deno-lint-ignore no-explicit-any
const manifest: any = parseYaml(await Deno.readTextFile("taskset.yaml"));
const expected = Object.keys(manifest.spec?.entries ?? {})
  .map((name) => `buildin/${name}`)
  .sort();

if (expected.length === 0) {
  console.error("taskset.yaml declares no entries");
  Deno.exit(1);
}

async function listTasks(): Promise<Json[]> {
  const res = await fetch(`${baseUrl}/api/tasks`);
  if (!res.ok) throw new Error(`GET /api/tasks: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : body.tasks ?? [];
}

async function getTask(id: string): Promise<Json> {
  const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET /api/tasks/${id}: ${res.status}`);
  return await res.json();
}

// ─── 1. every entry registered ────────────────────────────────────────────
// A kind: PipelineTask entry retries until every stage task it names has
// registered, so it lands after the plain tasks do.
const deadline = Date.now() + timeoutMs;
let missing: string[] = expected.slice();
while (Date.now() < deadline) {
  try {
    const have = new Set((await listTasks()).map((t: Json) => t.id));
    missing = expected.filter((id) => !have.has(id));
    if (missing.length === 0) break;
  } catch (err) {
    missing = [`(registry unreachable: ${err instanceof Error ? err.message : err})`];
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (missing.length > 0) {
  console.error(`::error::${missing.length} taskset entries never registered`);
  for (const id of missing) console.error(`  missing: ${id}`);
  Deno.exit(1);
}
console.log(`all ${expected.length} taskset entries registered`);

// ─── 2. resolved-spec contracts ───────────────────────────────────────────
const param = (spec: Json, name: string) =>
  (spec.params ?? []).find((p: Json) => p.name === name);
const envValue = (spec: Json, name: string) =>
  (spec.permissions?.env ?? []).find((e: Json) => e.name === name)?.value;

// The authoring agent's only route to disk is a task it can call as a tool.
// ${DATADIR}/ai-tasks is the ai-scratch source the daemon synthesises, so it
// is where `dicode task create` scaffolds. Every other root is a widening: a
// directory the daemon resolves taskset files from hands the caller the
// daemon's git credentials through a ref's auth.token_env.
{
  const spec = await getTask("buildin/write-task-file");
  const fs: Json[] = spec.permissions?.fs ?? [];
  check(
    fs.length === 1 && String(fs[0].Path).endsWith("/ai-tasks") && fs[0].Permission === "rw",
    `write-task-file fs grants = ${JSON.stringify(fs)}, want exactly one rw grant on \${DATADIR}/ai-tasks`,
  );

  // The grant is the outer boundary; the task's own path check is the inner
  // one, and it needs the roots to enforce anything. They ride in env because
  // an ai-agent hands the model every declared param as a settable tool
  // argument — a roots param would be caller-controlled.
  const roots = envValue(spec, "DICODE_TASK_FILE_ROOTS");
  check(
    typeof roots === "string" && roots.endsWith("/ai-tasks"),
    `write-task-file DICODE_TASK_FILE_ROOTS = ${JSON.stringify(roots)}, want \${DATADIR}/ai-tasks`,
  );
  check(
    !param(spec, "roots"),
    "write-task-file declares a roots param — the model can set it",
  );
  check(
    !!spec.description,
    "write-task-file needs a description — it is what the model sees as the tool's docs",
  );
}

// A tool the agent may call must also be in its dicode.tasks allowlist by the
// id run_task is invoked with, which is the namespaced one. The ai-agent base
// these entries override grants "*", so this pins the declared intent rather
// than the only thing permitting the call.
for (const id of ["buildin/task-create-turn"]) {
  const spec = await getTask(id);
  const tasks: string[] = spec.permissions?.dicode?.tasks ?? [];
  check(
    tasks.includes("buildin/write-task-file"),
    `${id} dicode.tasks missing buildin/write-task-file; got ${JSON.stringify(tasks)}`,
  );

  // The system prompt is the only place the model learns how to get files onto
  // disk; a prompt describing capabilities it has no tool for costs a paid
  // model call and produces nothing.
  const prompt = param(spec, "system_prompt")?.default ?? "";
  check(
    String(prompt).includes("write-task-file"),
    `${id} system_prompt never names the write tool`,
  );
}

// Taskset overrides REPLACE permissions.fs rather than adding to it, and
// buildin/ai-agent grants itself read on the skills directory. So any entry
// that overrides fs for its own reasons — a dev-clones path, a write root —
// silently drops that grant and every skill it declares fails to load at
// runtime. Nothing else catches it: the task still runs, the model just never
// sees the skills, and under skills_mode "index" it is left holding names it
// cannot read.
for (const summary of await listTasks()) {
  const spec = await getTask(summary.id);
  const skills = param(spec, "skills")?.default;
  if (!skills) continue;
  const readable = (spec.permissions?.fs ?? []).some(
    (e: Json) => String(e.Path).endsWith("/skills") && String(e.Permission).includes("r"),
  );
  check(
    readable,
    `${summary.id} declares skills "${skills}" but cannot read the skills directory; fs = ${
      JSON.stringify(spec.permissions?.fs)
    }`,
  );
}

if (failures.length > 0) {
  console.error(`::error::${failures.length} resolved-spec contract failures`);
  for (const f of failures) console.error(`  ${f}`);
  Deno.exit(1);
}
console.log("resolved-spec contracts hold");
