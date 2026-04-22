// Shared unified-diff helpers used by plan/apply formatters and online compare.

import { createTwoFilesPatch } from "diff";
import { sortedStringify } from "../planner/effects.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

function red(s: string): string { return `${RED}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }

export function sortedPretty(obj: unknown): string {
  return JSON.stringify(JSON.parse(sortedStringify(obj)), null, 2);
}

/** Colored unified diff body (headers stripped). */
export function unifiedDiff(
  oldStr: string,
  newStr: string,
  indent: string,
  labels: { old: string; new: string } = { old: "live", new: "desired" },
): string {
  const patch = createTwoFilesPatch(labels.old, labels.new, oldStr + "\n", newStr + "\n", "", "", { context: 3 });
  const lines = patch.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith("===") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      result.push(`${indent}${dim(line)}`);
    } else if (line.startsWith("-")) {
      result.push(`${indent}${red(line)}`);
    } else if (line.startsWith("+")) {
      result.push(`${indent}${green(line)}`);
    } else if (line.startsWith("\\")) {
      continue;
    } else if (line.length > 0) {
      result.push(`${indent} ${line.slice(1)}`);
    }
  }
  return result.join("\n");
}
