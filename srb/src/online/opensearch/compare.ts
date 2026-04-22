import { OpenSearchClient } from "../../opensearch/client.js";
import { compareDocs, type CompareResult, type DocSet } from "../../opensearch/compare.js";
import { sortedPretty, unifiedDiff } from "../../util/diff.js";

interface CompareOptions {
  opensearchUrl: string;
  opensearchUser?: string;
  opensearchPassword?: string;
  /** Fraction of docs to sample, e.g. 0.01 = 1%. Undefined = compare all. */
  sample?: number;
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

  const allDocsA: DocSet = new Map();
  let scrolled = 0;
  const scrollStart = Date.now();

  for await (const batch of openSearch.scrollDocs(indexA)) {
    for (const [id, doc] of batch) {
      if (sample !== undefined && Math.random() >= sample) continue;
      allDocsA.set(id, doc);
    }
    scrolled += batch.size;
    process.stdout.write(formatProgress(scrolled, countA, scrollStart, `Scrolling ${indexA}`, `selected ${allDocsA.size}`));
  }
  console.log();

  // Fetch matching docs from index B
  const selectedIds = [...allDocsA.keys()];
  const allDocsB: DocSet = new Map();
  const batchSize = 1000;
  let fetched = 0;
  const fetchStart = Date.now();

  for (let i = 0; i < selectedIds.length; i += batchSize) {
    const batchIds = selectedIds.slice(i, i + batchSize);
    const docs = await openSearch.getDocsByIds(indexB, batchIds);
    for (const [id, doc] of docs) {
      allDocsB.set(id, doc);
    }
    fetched = Math.min(i + batchSize, selectedIds.length);
    process.stdout.write(formatProgress(fetched, selectedIds.length, fetchStart, `Fetching ${indexB}`));
  }
  console.log();

  // 3. Compare
  const compareStart = Date.now();
  process.stdout.write(`\r  Comparing ${allDocsA.size} documents...`);
  const result = compareDocs(allDocsA, allDocsB);
  console.log(` done (${formatDuration(Date.now() - compareStart)})`);

  printResult(result, allDocsA.size, indexA, indexB);
  printSampleDiff(result, allDocsA, allDocsB, indexA, indexB);

  const totalElapsed = Date.now() - scrollStart;
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
  result: CompareResult,
  docsA: DocSet,
  docsB: DocSet,
  indexA: string,
  indexB: string,
): void {
  if (result.mismatching.length === 0) return;

  const id = result.mismatching[Math.floor(Math.random() * result.mismatching.length)]!;
  const a = docsA.get(id);
  const b = docsB.get(id);
  if (a === undefined || b === undefined) return;

  console.log(`\nExample diff — doc _id=${id}:`);
  console.log(unifiedDiff(sortedPretty(a), sortedPretty(b), "  ", { old: indexA, new: indexB }));
}
