/** Map from _id to _source document */
export type DocSet = Map<string, Record<string, unknown>>;

export interface CompareResult {
  matching: number;
  mismatching: string[];
  onlyInA: string[];
  onlyInB: string[];
}

/** Compare two sets of documents by _id, returning diffs. */
export function compareDocs(a: DocSet, b: DocSet): CompareResult {
  let matching = 0;
  const mismatching: string[] = [];
  const onlyInA: string[] = [];

  for (const [id, docA] of a) {
    const docB = b.get(id);
    if (docB === undefined) {
      onlyInA.push(id);
    } else if (JSON.stringify(docA) === JSON.stringify(docB)) {
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
