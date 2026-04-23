import { OpenSearchClient } from "../../opensearch/client.js";
import { canonicalize, type CompareResult } from "../../opensearch/compare.js";
import { sortedPretty, unifiedDiff } from "../../util/diff.js";

interface CompareOptions {
  opensearchUrl: string;
  opensearchUser?: string;
  opensearchPassword?: string;
  /** Fraction of docs to sample, e.g. 0.01 = 1%. Undefined = compare all. */
  sample?: number;
  /** Dotted field paths (or path prefixes) to ignore during comparison and diff rendering. */
  ignoreFields?: string[];
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function progressBar(fraction: number, width = 30): string {
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  return `[${"=".repeat(filled)}${empty > 0 ? ">" : ""}${".".repeat(Math.max(0, empty - 1))}]`;
}

function formatProgress(current: number, total: number, startTime: number, label: string, extra?: string): string {
  const fraction = total > 0 ? current / total : 0;
  const pct = (fraction * 100).toFixed(1);
  const elapsed = Date.now() - startTime;
  const eta = fraction > 0 ? (elapsed / fraction) * (1 - fraction) : 0;

  let line = `\r  ${label} ${progressBar(fraction)} ${pct}%  ${current}/${total}`;
  if (extra) line += `  ${extra}`;
  line += `  elapsed ${formatDuration(elapsed)}`;
  if (fraction > 0.01 && fraction < 1) line += `  eta ${formatDuration(eta)}`;

  return line;
}

export async function compareIndexesCommand(
  indexA: string,
  indexB: string,
  opts: CompareOptions,
): Promise<void> {
  const openSearch = new OpenSearchClient(
    opts.opensearchUrl,
    opts.opensearchUser && opts.opensearchPassword
      ? { user: opts.opensearchUser, password: opts.opensearchPassword }
      : undefined,
  );

  // 1. Compare doc counts
  const [countA, countB] = await Promise.all([
    openSearch.getDocCount(indexA),
    openSearch.getDocCount(indexB),
  ]);

  console.log(`\nDoc counts:`);
  console.log(`  ${indexA}: ${countA}`);
  console.log(`  ${indexB}: ${countB}`);
  if (countA !== countB) {
    console.log(`  ⚠ Count mismatch: ${Math.abs(countA - countB)} difference`);
  } else {
    console.log(`  ✓ Counts match`);
  }

  // 2. Compare documents
  const sample = opts.sample;
  if (sample !== undefined) {
    console.log(`\nSampling ${(sample * 100).toFixed(2)}% of documents (~${Math.round(countA * sample)} docs)...`);
  } else {
    console.log(`\nComparing all ${countA} documents...`);
  }

  const overallStart = Date.now();
  const ignoreFields = opts.ignoreFields ?? [];

  // Stream batches of docs from A, fetch corresponding IDs from B, compare,
  // discard. This caps memory at one batch worth of docs rather than the full
  // sample, which matters for large indices (≫10k sampled docs).
  const target = sample !== undefined ? Math.max(1, Math.round(countA * sample)) : countA;
  const batchIterator: AsyncIterable<Map<string, Record<string, unknown>>> =
    sample !== undefined
      ? openSearch.sampleDocsBatched(indexA, target)
      : openSearch.scrollDocs(indexA);

  const result: CompareResult = { matching: 0, mismatching: [], onlyInA: [], onlyInB: [] };
  let exampleDiff: { id: string; a: Record<string, unknown>; b: Record<string, unknown> } | null = null;
  let compared = 0;
  const workStart = Date.now();
  const label = sample !== undefined ? `Sampling+comparing` : `Scrolling+comparing`;

  let lastSeen: [string, Record<string, unknown>] | null = null;
  for await (const batchA of batchIterator) {
    for (const [id, doc] of batchA) lastSeen = [id, doc];
    if (batchA.size === 0) continue;

    const ids = [...batchA.keys()];
    const batchB = await openSearch.getDocsByIds(indexB, ids);

    for (const [id, docA] of batchA) {
      const docB = batchB.get(id);
      if (docB === undefined) {
        result.onlyInA.push(id);
        continue;
      }
      const canonA = canonicalize(docA, ignoreFields);
      const canonB = canonicalize(docB, ignoreFields);
      if (JSON.stringify(canonA) === JSON.stringify(canonB)) {
        result.matching++;
      } else {
        result.mismatching.push(id);
        if (exampleDiff === null) exampleDiff = { id, a: docA, b: docB };
      }
    }

    compared += batchA.size;
    process.stdout.write(formatProgress(compared, target, workStart, label, `compared ${compared}`));
  }

  // Guarantee at least one doc is compared on non-empty indices.
  if (compared === 0 && lastSeen !== null) {
    const [id, docA] = lastSeen;
    const batchB = await openSearch.getDocsByIds(indexB, [id]);
    const docB = batchB.get(id);
    if (docB === undefined) {
      result.onlyInA.push(id);
    } else {
      const canonA = canonicalize(docA, ignoreFields);
      const canonB = canonicalize(docB, ignoreFields);
      if (JSON.stringify(canonA) === JSON.stringify(canonB)) {
        result.matching++;
      } else {
        result.mismatching.push(id);
        exampleDiff = { id, a: docA, b: docB };
      }
    }
    compared = 1;
  }
  console.log();

  if (ignoreFields.length > 0) {
    console.log(`\nIgnored fields: ${ignoreFields.join(", ")}`);
  }
  printResult(result, compared, indexA, indexB);
  printSampleDiff(result, exampleDiff, indexA, indexB, ignoreFields);

  const totalElapsed = Date.now() - overallStart;
  console.log(`\nTotal time: ${formatDuration(totalElapsed)}`);

  const hasDiffs = result.mismatching.length > 0 || result.onlyInA.length > 0 || result.onlyInB.length > 0;
  process.exit(hasDiffs ? 1 : 0);
}

function printResult(
  result: CompareResult,
  compared: number,
  indexA: string,
  indexB: string,
): void {
  console.log(`\nResults (${compared} docs compared):`);
  console.log(`  ✓ Matching: ${result.matching}`);

  if (result.mismatching.length > 0) {
    console.log(`  ✗ Mismatching: ${result.mismatching.length}`);
    const preview = result.mismatching.slice(0, 10);
    for (const id of preview) {
      console.log(`    - ${id}`);
    }
    if (result.mismatching.length > 10) {
      console.log(`    ... and ${result.mismatching.length - 10} more`);
    }
  }

  if (result.onlyInA.length > 0) {
    console.log(`  Only in ${indexA}: ${result.onlyInA.length}`);
    const preview = result.onlyInA.slice(0, 5);
    for (const id of preview) {
      console.log(`    - ${id}`);
    }
    if (result.onlyInA.length > 5) {
      console.log(`    ... and ${result.onlyInA.length - 5} more`);
    }
  }

  if (result.onlyInB.length > 0) {
    console.log(`  Only in ${indexB}: ${result.onlyInB.length}`);
    const preview = result.onlyInB.slice(0, 5);
    for (const id of preview) {
      console.log(`    - ${id}`);
    }
    if (result.onlyInB.length > 5) {
      console.log(`    ... and ${result.onlyInB.length - 5} more`);
    }
  }

  if (result.mismatching.length === 0 && result.onlyInA.length === 0 && result.onlyInB.length === 0) {
    console.log(`\n  ✓ All compared documents match`);
  }
}

function printSampleDiff(
  _result: CompareResult,
  example: { id: string; a: Record<string, unknown>; b: Record<string, unknown> } | null,
  indexA: string,
  indexB: string,
  ignoreFields: string[],
): void {
  if (example === null) return;

  const canonA = canonicalize(example.a, ignoreFields);
  const canonB = canonicalize(example.b, ignoreFields);
  console.log(`\nExample diff — doc _id=${example.id}:`);
  console.log(`  \x1b[31m- RED:   ${indexA}\x1b[0m`);
  console.log(`  \x1b[32m+ GREEN: ${indexB}\x1b[0m`);
  console.log(unifiedDiff(sortedPretty(canonA), sortedPretty(canonB), "  ", { old: indexA, new: indexB }));
}
