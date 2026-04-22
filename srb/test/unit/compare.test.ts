import { describe, test, expect } from "bun:test";
import { canonicalize, compareDocs, type DocSet } from "../../src/opensearch/compare.js";

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

  test("treats docs equal regardless of object key order", () => {
    const a = makeDocSet({ "1": { name: "Alice", age: 30 } });
    const b = makeDocSet({ "1": { age: 30, name: "Alice" } });
    expect(compareDocs(a, b).matching).toBe(1);
  });

  test("treats array order as insignificant", () => {
    const a = makeDocSet({
      "1": { tags: [{ k: "a", v: 1 }, { k: "b", v: 2 }] },
    });
    const b = makeDocSet({
      "1": { tags: [{ k: "b", v: 2 }, { k: "a", v: 1 }] },
    });
    expect(compareDocs(a, b).matching).toBe(1);
  });

  test("ignoreFields drops a top-level field and its subtree", () => {
    const a = makeDocSet({ "1": { name: "Alice", _meta: { x: 1 } } });
    const b = makeDocSet({ "1": { name: "Alice", _meta: { x: 2 } } });
    const result = compareDocs(a, b, { ignoreFields: ["_meta"] });
    expect(result.matching).toBe(1);
    expect(result.mismatching).toEqual([]);
  });

  test("ignoreFields matches a nested dotted path", () => {
    const a = makeDocSet({ "1": { user: { name: "Alice", os_indexed_at: "t1" } } });
    const b = makeDocSet({ "1": { user: { name: "Alice", os_indexed_at: "t2" } } });
    const result = compareDocs(a, b, { ignoreFields: ["user.os_indexed_at"] });
    expect(result.matching).toBe(1);
  });

  test("ignoreFields only matches exact paths and descendants, not arbitrary substrings", () => {
    const a = makeDocSet({ "1": { metaData: 1 } });
    const b = makeDocSet({ "1": { metaData: 2 } });
    // "_meta" should NOT match "metaData" (pure substring match would be wrong).
    const result = compareDocs(a, b, { ignoreFields: ["_meta"] });
    expect(result.matching).toBe(0);
    expect(result.mismatching).toEqual(["1"]);
  });

  test("ignoreFields path that doesn't match leaves the diff in place", () => {
    const a = makeDocSet({ "1": { name: "Alice", age: 30 } });
    const b = makeDocSet({ "1": { name: "Alice", age: 31 } });
    const result = compareDocs(a, b, { ignoreFields: ["_meta"] });
    expect(result.matching).toBe(0);
    expect(result.mismatching).toEqual(["1"]);
  });
});

describe("canonicalize", () => {
  test("sorts object keys", () => {
    const out = canonicalize({ b: 1, a: 2 });
    expect(JSON.stringify(out)).toBe('{"a":2,"b":1}');
  });

  test("sorts arrays by content", () => {
    const out = canonicalize([{ k: "b" }, { k: "a" }]);
    expect(JSON.stringify(out)).toBe('[{"k":"a"},{"k":"b"}]');
  });

  test("recursively sorts nested structures", () => {
    const out = canonicalize({ x: [{ z: 2, y: 1 }, { z: 1, y: 2 }] });
    expect(JSON.stringify(out)).toBe('{"x":[{"y":1,"z":2},{"y":2,"z":1}]}');
  });

  test("drops ignored top-level path and its subtree", () => {
    const out = canonicalize({ a: 1, _meta: { x: 1 } }, ["_meta"]);
    expect(JSON.stringify(out)).toBe('{"a":1}');
  });

  test("drops ignored nested path", () => {
    const out = canonicalize({ user: { name: "a", os_indexed_at: "t" } }, ["user.os_indexed_at"]);
    expect(JSON.stringify(out)).toBe('{"user":{"name":"a"}}');
  });

  test("drops ignored field inside each array element (arrays traversed without index)", () => {
    const out = canonicalize({ items: [{ id: 1, ts: "a" }, { id: 2, ts: "b" }] }, ["items.ts"]);
    expect(JSON.stringify(out)).toBe('{"items":[{"id":1},{"id":2}]}');
  });
});
