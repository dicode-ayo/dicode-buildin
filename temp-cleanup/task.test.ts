/**
 * task.test.ts — unit tests for buildin/temp-cleanup.
 *
 * The sweep's correctness question is which directory it runs against. The
 * runtimes allocate their wrapper files through Go's os.CreateTemp(""), which
 * is /tmp only on Unix; on Windows it is %TEMP%. These tests pin that the task
 * reads the root from node:os rather than a literal, and that the file sweep
 * takes the root as an argument so the two can never be re-fused.
 *
 * parseRunID and sweepTempFiles are exported for this file; main() is not
 * exercised directly because it needs a live IPC-backed `dicode` handle.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRunID, sweepTempFiles, TEMP_DIR } from "./task.ts";

Deno.test("TEMP_DIR is the platform temp root, not a POSIX literal", () => {
  assertEquals(TEMP_DIR, tmpdir());
});

Deno.test("parseRunID extracts the run id from each wrapper prefix", () => {
  const runID = "550e8400-e29b-41d4-a716-446655440000";
  for (const kind of ["shim", "runner", "task"]) {
    assertEquals(parseRunID(`dicode-${kind}-${runID}__48817033.ts`), runID);
  }
});

Deno.test("parseRunID ignores names that are not wrapper files", () => {
  assertEquals(parseRunID("unrelated.ts"), null);
  assertEquals(parseRunID("dicode-shim-no-separator.ts"), null);
});

Deno.test("sweepTempFiles deletes orphans and keeps live runs", async () => {
  const root = await Deno.makeTempDir({ prefix: "temp-cleanup-test-" });
  const orphan = "dicode-shim-11111111-1111-1111-1111-111111111111__aaa.ts";
  const live = "dicode-runner-22222222-2222-2222-2222-222222222222__bbb.ts";
  const foreign = "some-other-tool.tmp";
  for (const name of [orphan, live, foreign]) {
    await Deno.writeTextFile(join(root, name), "");
  }

  const counts = await sweepTempFiles(
    root,
    new Set(["22222222-2222-2222-2222-222222222222"]),
  );

  assertEquals(counts, { scanned: 2, deleted: 1, skipped: 1 });
  const left = [...Deno.readDirSync(root)].map((e) => e.name).sort();
  assertEquals(left, [foreign, live].sort());

  await Deno.remove(root, { recursive: true });
});

// A Windows temp root is backslash-separated. Joining it to an entry name with
// a hardcoded "/" yields a mixed-separator path that Deno's permission check
// sees as a different string than the granted root.
Deno.test("sweepTempFiles builds paths with the platform separator", async () => {
  const root = await Deno.makeTempDir({ prefix: "temp-cleanup-sep-" });
  const name = "dicode-task-33333333-3333-3333-3333-333333333333__ccc.ts";
  await Deno.writeTextFile(join(root, name), "");

  const counts = await sweepTempFiles(root, new Set<string>());

  assertEquals(counts, { scanned: 1, deleted: 1, skipped: 0 });
  assertEquals([...Deno.readDirSync(root)].length, 0);

  await Deno.remove(root, { recursive: true });
});
