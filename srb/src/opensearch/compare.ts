/** Map from _id to _source document */
export type DocSet = Map<string, Record<string, unknown>>;

export interface CompareResult {
  matching: number;
  mismatching: string[];
  onlyInA: string[];
  onlyInB: string[];
}

export interface CompareOptions {
  /**
   * Dotted field paths to ignore. A pattern matches a path if the path equals
   * the pattern or is a descendant of it (i.e. starts with `pattern.`). Array
   * elements are traversed without index segments, so `customFields.number.apiName`
   * matches every element's `apiName`.
   */
  ignoreFields?: string[];
}

const IGNORED = Symbol("ignored");

function pathIgnored(path: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (path === p || path.startsWith(`${p}.`)) return true;
  }
  return false;
}

/**
 * Recursively canonicalize a value:
 *  - sort object keys
 *  - sort arrays by canonical content (order-insensitive)
 *  - drop any field whose dotted path matches an ignore pattern
 */
export function canonicalize(value: unknown, ignore: string[] = [], path = ""): unknown {
  if (path && pathIgnored(path, ignore)) return IGNORED;

  if (Array.isArray(value)) {
    const normalized = value
      .map(el => canonicalize(el, ignore, path))
      .filter(el => el !== IGNORED);
    // Stable sort by canonical string
    return normalized
      .map(el => ({ k: JSON.stringify(el), v: el }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .map(el => el.v);
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const subPath = path ? `${path}.${key}` : key;
      const sub = canonicalize(obj[key], ignore, subPath);
      if (sub !== IGNORED) out[key] = sub;
    }
    return out;
  }

  return value;
}

/** Compare two sets of documents by _id, returning diffs. */
export function compareDocs(a: DocSet, b: DocSet, opts: CompareOptions = {}): CompareResult {
  const ignore = opts.ignoreFields ?? [];
  let matching = 0;
  const mismatching: string[] = [];
  const onlyInA: string[] = [];

  for (const [id, docA] of a) {
    const docB = b.get(id);
    if (docB === undefined) {
      onlyInA.push(id);
    } else if (
      JSON.stringify(canonicalize(docA, ignore)) ===
      JSON.stringify(canonicalize(docB, ignore))
    ) {
      matching++;
    } else {
      mismatching.push(id);
    }
  }

  const onlyInB: string[] = [];
  for (const id of b.keys()) {
    if (!a.has(id)) {
      onlyInB.push(id);
    }
  }

  return { matching, mismatching, onlyInA, onlyInB };
}
