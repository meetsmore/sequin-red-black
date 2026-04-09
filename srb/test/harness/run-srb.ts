import * as path from "path";
import {
  TEST_SEQUIN_URL,
  TEST_SEQUIN_TOKEN,
  TEST_OS_URL,
  SEQUIN_CONTEXT,
  COMPILED_PATH,
} from "./constants.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runSRB(...args: string[]): Promise<RunResult> {
  const srbPath = path.resolve(import.meta.dir, "../../src/cli.ts");
  const proc = Bun.spawn(["bun", "run", srbPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SRB_SEQUIN_URL: TEST_SEQUIN_URL,
      SRB_SEQUIN_TOKEN: TEST_SEQUIN_TOKEN,
      SRB_OPENSEARCH_URL: TEST_OS_URL,
      SRB_SEQUIN_CONTEXT: SEQUIN_CONTEXT,
      SRB_COMPILED: COMPILED_PATH,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}
