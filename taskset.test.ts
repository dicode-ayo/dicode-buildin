/**
 * taskset.test.ts — contract assertions on the manifest itself.
 *
 * These pin decisions that no task's own unit test can see, because they live
 * in `taskset.yaml`'s overrides and in `task-create/`'s pipeline shape rather
 * than in any task.ts. A capability granted here becomes a tool the model can
 * call, so the withheld ones are as much a part of the contract as the
 * granted ones.
 */
import { parse as parseYaml } from "jsr:@std/yaml@1";
import { assert, assertEquals } from "jsr:@std/assert@1";

// deno-lint-ignore no-explicit-any
type Yaml = any;

const taskset: Yaml = parseYaml(await Deno.readTextFile("taskset.yaml"));
const pipeline: Yaml = parseYaml(
  await Deno.readTextFile("task-create/task.yaml"),
);
const autoFixSkill = await Deno.readTextFile("skills/dicode-auto-fix.md");

function entry(name: string): Yaml {
  const e = taskset.spec?.entries?.[name];
  assert(e, `${name} entry not found in taskset.yaml`);
  return e;
}

Deno.test("task-create-turn grants exactly the authoring capabilities", () => {
  const d = entry("task-create-turn").overrides?.dicode;
  assert(d, "task-create-turn overrides.dicode is missing");

  for (
    const cap of [
      "sources_list",
      "sources_set_dev_mode",
      "tasks_test",
      "git_commit_push",
      "list_tasks",
      "get_runs",
    ]
  ) {
    assertEquals(d[cap], true, `${cap} must be granted to the authoring turn`);
  }

  // Scaffolding a new task has no prior run to read, pin, unpin or replay.
  for (
    const cap of [
      "runs_replay",
      "runs_get_input",
      "runs_pin_input",
      "runs_unpin_input",
    ]
  ) {
    assert(
      !d[cap],
      `${cap} must stay withheld: there is no prior run to act on`,
    );
  }
});

Deno.test("task-create-turn names git-pr by its namespaced id", () => {
  const tasks: string[] = entry("task-create-turn").overrides?.dicode?.tasks ??
    [];
  // taskAllowed compares against the id dicode.run_task is called with, so a
  // bare "git-pr" can never match and silently falls back to the base
  // ai-agent's "*" wildcard instead of the restriction this list expresses.
  assert(
    !tasks.includes("git-pr"),
    `bare "git-pr" can never match a namespaced call id; want "buildin/git-pr"`,
  );
  assert(
    tasks.includes("buildin/git-pr"),
    `tasks slice missing buildin/git-pr; got ${JSON.stringify(tasks)}`,
  );
});

Deno.test("task-create-turn keeps an rw grant on the dev-clones scratch dir", () => {
  const fs: Yaml[] = entry("task-create-turn").overrides?.fs ?? [];
  assert(
    fs.some((g) =>
      String(g.path).includes("dev-clones") && g.permission === "rw"
    ),
    `missing rw dev-clones grant; got ${JSON.stringify(fs)}`,
  );
});

Deno.test("task-create-turn is manual-only", () => {
  // Fired via FireManual from the control socket — the authoring session, not
  // an HTTP caller, owns dispatch.
  const trigger = entry("task-create-turn").overrides?.trigger;
  assert(trigger, "task-create-turn has no trigger override");
  assertEquals(trigger.manual, true, "trigger.manual must be explicitly true");
  assert(!trigger.webhook, `trigger.webhook = ${trigger.webhook}, want unset`);
});

Deno.test("task-create-turn carries dicodai's provider defaults", () => {
  // Unlike auto-fix (deliberately no provider defaults), this defaults to
  // OpenAI so `dicode task create --ai` works with only OPENAI_API_KEY set.
  const o = entry("task-create-turn").overrides;
  const params = o?.params ?? {};
  for (
    const [name, want] of Object.entries({
      model: "gpt-4o",
      base_url: "https://api.openai.com/v1",
      api_key_env: "OPENAI_API_KEY",
      skills: "dicode-task-dev,dicode-basics",
    })
  ) {
    assertEquals(params[name], want, `param ${name}`);
  }
  assert(
    (o?.env ?? []).includes("OPENAI_API_KEY"),
    `env grants missing OPENAI_API_KEY; got ${JSON.stringify(o?.env)}`,
  );
  assert(
    (o?.net ?? []).includes("api.openai.com"),
    `net grants missing api.openai.com; got ${JSON.stringify(o?.net)}`,
  );
});

Deno.test("task-create verifies what the turn claimed to write", () => {
  // The post-condition is not in the control plane — that fires whatever
  // ai.create_task names — so it exists only while task-create stays a
  // pipeline whose last stage reads the disk. Collapsing it back to a bare
  // agent entry restores the bug where a turn that wrote nothing settles
  // green, so that has to be a deliberate act that fails this test.
  assertEquals(
    pipeline.kind,
    "PipelineTask",
    "task-create must stay a pipeline",
  );
  const stages: Yaml[] = pipeline.stages ?? [];
  assert(
    stages.length >= 2,
    `stages = ${stages.length}, want the agent turn plus a verification stage`,
  );
  assertEquals(stages[0].task, "buildin/task-create-turn", "first stage");
  assertEquals(
    stages[stages.length - 1].task,
    "buildin/verify-task-written",
    "terminal stage — a failing terminal stage is what fails the run",
  );
});

Deno.test("task-create threads the fire params into its stages", () => {
  const stages: Yaml[] = pipeline.stages ?? [];
  const first = stages[0];
  assert(
    first.overrides,
    "first stage must thread the fire params through overrides",
  );

  // Stages receive no params of their own and ${input.params.…} resolves only
  // on the first stage, so these have to be threaded explicitly or the agent
  // runs with bare defaults and no prompt.
  const threaded: Record<string, string> = {};
  for (const p of first.overrides.params ?? []) threaded[p.name] = p.default;
  for (
    const [name, want] of Object.entries({
      prompt: "${input.params.prompt}",
      session_id: "${input.params.session_id}",
      // task_dir is authoring's concern, not the generic agent's: it rides
      // across the turn in the agent's opaque caller_context pass-through.
      caller_context: "${input.params.task_dir}",
    })
  ) {
    assertEquals(threaded[name], want, `first stage param ${name}`);
  }

  // The verification stage learns the directory from the turn's return value;
  // without this it would check nothing and pass everything.
  const last = stages[stages.length - 1];
  const verifyDir = (last.overrides?.params ?? [])
    .find((p: Yaml) => p.name === "task_dir")?.default;
  assertEquals(
    verifyDir,
    "${input.output.caller_context}",
    "verify stage task_dir",
  );
});

Deno.test("auto-fix grants the diagnose-fix-land capabilities", () => {
  const d = entry("auto-fix").overrides?.dicode;
  assert(d, "auto-fix overrides.dicode is missing");
  for (
    const cap of [
      "runs_replay",
      "runs_get_input",
      "runs_pin_input",
      "runs_unpin_input",
      "sources_set_dev_mode",
      "tasks_test",
      "git_commit_push",
      "list_tasks",
      "get_runs",
    ]
  ) {
    assertEquals(d[cap], true, `${cap} must be granted to auto-fix`);
  }

  const tasks: string[] = d.tasks ?? [];
  assert(
    !tasks.includes("git-pr"),
    `bare "git-pr" can never match a namespaced call id; want "buildin/git-pr"`,
  );
  assert(
    tasks.includes("buildin/git-pr"),
    `auto-fix tasks slice missing buildin/git-pr; got ${JSON.stringify(tasks)}`,
  );
});

Deno.test("the auto-fix skill names tools, not SDK methods", () => {
  // The skill names the tools the model is handed, not the SDK methods behind
  // them: a model cannot call the SDK, so an SDK name in the skill describes a
  // capability the reader does not have.
  for (
    const term of [
      "dicode_get_run_input",
      "dicode_pin_run_input",
      "dicode_unpin_run_input",
      "dicode_set_dev_mode",
      "dicode_git_commit_push",
      "dicode_test_task",
      "dicode_replay_run",
      "max_iterations",
    ]
  ) {
    assert(
      autoFixSkill.includes(term),
      `skill missing required term "${term}"`,
    );
  }
  for (
    const forbidden of [
      "dicode.runs.",
      "dicode.tasks.",
      "dicode.sources.",
      "dicode.git.",
      "Deno.readTextFile",
      "Deno.writeTextFile",
    ]
  ) {
    assert(
      !autoFixSkill.includes(forbidden),
      `skill names "${forbidden}", which the model has no way to call`,
    );
  }
});
