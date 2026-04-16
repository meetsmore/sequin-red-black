import { test, expect, describe } from "bun:test";
import { findOccupiedOsColors } from "../../src/state/discover.js";
import type { Color } from "../../src/config/types.js";

describe("findOccupiedOsColors", () => {
  test("detects OS indices not in Sequin-managed pipelines", () => {
    const osIndices = [
      { name: "jobs_red", health: "green", docCount: 1000 },
      { name: "clients_red", health: "green", docCount: 500 },
      { name: ".kibana", health: "green", docCount: 10 },
    ];
    const managedKeys = new Set<string>();

    const occupied = findOccupiedOsColors(osIndices, managedKeys);

    expect(occupied.get("jobs")).toEqual(new Set<Color>(["red"]));
    expect(occupied.get("clients")).toEqual(new Set<Color>(["red"]));
    expect(occupied.has(".kibana")).toBe(false);
  });

  test("excludes indices already managed by Sequin", () => {
    const osIndices = [
      { name: "jobs_red", health: "green", docCount: 1000 },
      { name: "jobs_black", health: "green", docCount: 0 },
    ];
    const managedKeys = new Set(["jobs:red"]);

    const occupied = findOccupiedOsColors(osIndices, managedKeys);

    expect(occupied.get("jobs")).toEqual(new Set<Color>(["black"]));
  });

  test("returns empty map when no foreign indices exist", () => {
    const osIndices = [
      { name: "jobs_red", health: "green", docCount: 1000 },
    ];
    const managedKeys = new Set(["jobs:red"]);

    const occupied = findOccupiedOsColors(osIndices, managedKeys);

    expect(occupied.size).toBe(0);
  });
});
