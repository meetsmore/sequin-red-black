import { test, expect, describe } from "bun:test";
import { pickTargetColor } from "../../src/planner/plan.js";
import type { PipelineKey, LivePipelineState, Color } from "../../src/config/types.js";

describe("pickTargetColor with occupiedColors", () => {
  test("skips colors occupied by foreign OS indices", () => {
    const live = new Map<PipelineKey, LivePipelineState>();
    const occupied = new Map<string, Set<Color>>([["jobs", new Set<Color>(["red"])]]);

    const color = pickTargetColor("jobs", live, occupied);

    expect(color).not.toBe("red");
  });

  test("skips both live and occupied colors", () => {
    const live = new Map<PipelineKey, LivePipelineState>([
      ["jobs:black" as PipelineKey, {} as LivePipelineState],
    ]);
    const occupied = new Map<string, Set<Color>>([["jobs", new Set<Color>(["red"])]]);

    const color = pickTargetColor("jobs", live, occupied);

    expect(color).not.toBe("red");
    expect(color).not.toBe("black");
  });

  test("works with no occupied colors (backwards compatible)", () => {
    const live = new Map<PipelineKey, LivePipelineState>();

    const color = pickTargetColor("jobs", live);

    expect(color).toBe("red");
  });
});

describe("pickTargetColor with allowedColors", () => {
  test("skips disallowed colors even when available", () => {
    const live = new Map<PipelineKey, LivePipelineState>();
    const allowed: Color[] = ["blue", "green", "purple", "orange", "yellow"];

    const color = pickTargetColor("jobs", live, undefined, undefined, allowed);

    expect(color).toBe("blue");
    expect(color).not.toBe("red");
    expect(color).not.toBe("black");
  });

  test("ignores preferredColor when it is not in allowedColors", () => {
    const live = new Map<PipelineKey, LivePipelineState>();
    const allowed: Color[] = ["blue", "green"];

    const color = pickTargetColor("jobs", live, undefined, "red", allowed);

    expect(color).toBe("blue");
  });

  test("picks first allowed color that is not occupied", () => {
    const live = new Map<PipelineKey, LivePipelineState>([
      ["jobs:blue" as PipelineKey, {} as LivePipelineState],
    ]);
    const allowed: Color[] = ["blue", "green", "purple"];

    const color = pickTargetColor("jobs", live, undefined, undefined, allowed);

    expect(color).toBe("green");
  });
});
