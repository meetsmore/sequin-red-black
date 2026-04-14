import { describe, test, expect } from "bun:test";
import { compareDocs, type DocSet } from "../../src/opensearch/compare.js";

function makeDocSet(docs: Record<string, Record<string, unknown>>): DocSet {
  return new Map(Object.entries(docs));
}

describe("compareDocs", () => {
  test("identical docs produce zero diffs", () => {
    const a = makeDocSet({
      "1": { name: "Alice", age: 30 },
      "2": { name: "Bob", age: 25 },
    });
    const b = makeDocSet({
      "1": { name: "Alice", age: 30 },
      "2": { name: "Bob", age: 25 },
    });
    const result = compareDocs(a, b);
    expect(result.matching).toBe(2);
    expect(result.mismatching).toEqual([]);
    expect(result.onlyInA).toEqual([]);
    expect(result.onlyInB).toEqual([]);
  });

  test("detects docs only in A", () => {
    const a = makeDocSet({
      "1": { name: "Alice" },
      "2": { name: "Bob" },
    });
    const b = makeDocSet({
      "1": { name: "Alice" },
    });
    const result = compareDocs(a, b);
    expect(result.matching).toBe(1);
    expect(result.onlyInA).toEqual(["2"]);
    expect(result.onlyInB).toEqual([]);
  });

  test("detects docs only in B", () => {
    const a = makeDocSet({
      "1": { name: "Alice" },
    });
    const b = makeDocSet({
      "1": { name: "Alice" },
      "2": { name: "Bob" },
    });
    const result = compareDocs(a, b);
    expect(result.matching).toBe(1);
    expect(result.onlyInA).toEqual([]);
    expect(result.onlyInB).toEqual(["2"]);
  });

  test("detects mismatching docs", () => {
    const a = makeDocSet({
      "1": { name: "Alice", age: 30 },
      "2": { name: "Bob", age: 25 },
    });
    const b = makeDocSet({
      "1": { name: "Alice", age: 31 },
      "2": { name: "Bob", age: 25 },
    });
    const result = compareDocs(a, b);
    expect(result.matching).toBe(1);
    expect(result.mismatching).toEqual(["1"]);
  });

  test("handles empty doc sets", () => {
    const a = makeDocSet({});
    const b = makeDocSet({});
    const result = compareDocs(a, b);
    expect(result.matching).toBe(0);
    expect(result.mismatching).toEqual([]);
    expect(result.onlyInA).toEqual([]);
    expect(result.onlyInB).toEqual([]);
  });

  test("detects deeply nested differences", () => {
    const a = makeDocSet({
      "1": { user: { address: { city: "NYC" } } },
    });
    const b = makeDocSet({
      "1": { user: { address: { city: "LA" } } },
    });
    const result = compareDocs(a, b);
    expect(result.matching).toBe(0);
    expect(result.mismatching).toEqual(["1"]);
  });

  test("combined: some matching, some mismatching, some only in A/B", () => {
    const a = makeDocSet({
      "1": { name: "Alice" },
      "2": { name: "Bob" },
      "3": { name: "Charlie" },
    });
    const b = makeDocSet({
      "1": { name: "Alice" },
      "2": { name: "Robert" },
      "4": { name: "Diana" },
    });
    const result = compareDocs(a, b);
    expect(result.matching).toBe(1);
    expect(result.mismatching).toEqual(["2"]);
    expect(result.onlyInA).toEqual(["3"]);
    expect(result.onlyInB).toEqual(["4"]);
  });
});
