import { test, expect, describe } from "bun:test";
import { findOccupiedOsColors, normalizeLiveDestination } from "../../src/state/discover.js";
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

describe("normalizeLiveDestination", () => {
  test("strips trailing _<color> from index_name to match the bare alias template", () => {
    // The user's CI bug: Sequin exports destination.index_name as "jobs_red"
    // (the deployed index), the sink.yaml template carries the bare alias
    // "jobs". Without this normalization, the planner sees a phantom diff and
    // replans a full backfill onto a new color.
    const out = normalizeLiveDestination(
      {
        type: "elasticsearch",
        endpoint_url: "https://opensearch.example.com",
        auth_type: "none",
        index_name: "jobs_red",
      },
      "red",
    );
    expect(out.index_name).toBe("jobs");
  });

  test("leaves index_name alone when the suffix doesn't match the discovered color", () => {
    // Defensive: only strip the exact color this sink was discovered at.
    // If for any reason the index_name ends in a different suffix, leave it.
    const out = normalizeLiveDestination(
      { index_name: "jobs_blue" },
      "red",
    );
    expect(out.index_name).toBe("jobs_blue");
  });

  test("leaves index_name alone when there's no color suffix at all", () => {
    // Could happen if a user deployed with raw sink.yaml (no SRB color
    // stamping) — we mustn't mangle the name in that case.
    const out = normalizeLiveDestination(
      { index_name: "jobs" },
      "red",
    );
    expect(out.index_name).toBe("jobs");
  });

  test("returns an empty object when destination is undefined", () => {
    expect(normalizeLiveDestination(undefined, "red")).toEqual({});
  });

  test("preserves all non-index_name fields", () => {
    const out = normalizeLiveDestination(
      {
        type: "elasticsearch",
        endpoint_url: "https://example.com",
        auth_type: "basic",
        batch_size: 1000,
        index_name: "jobs_red",
      },
      "red",
    );
    expect(out).toEqual({
      type: "elasticsearch",
      endpoint_url: "https://example.com",
      auth_type: "basic",
      batch_size: 1000,
      index_name: "jobs",
    });
  });

  test("does not mutate the input", () => {
    const input: Record<string, unknown> = { index_name: "jobs_red" };
    normalizeLiveDestination(input, "red");
    expect(input.index_name).toBe("jobs_red");
  });
});
