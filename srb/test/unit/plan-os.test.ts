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
