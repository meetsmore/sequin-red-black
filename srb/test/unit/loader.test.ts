import { test, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import * as fs from "fs/promises";
import { loadPipeline, loadSrbConfig } from "../../src/config/loader.js";
import { ALL_COLORS } from "../../src/config/types.js";

const tmpDir = path.join(import.meta.dir, ".tmp-loader-test");

beforeAll(async () => {
  const pipelineDir = path.join(tmpDir, "widgets");
  await fs.mkdir(pipelineDir, { recursive: true });

  await Bun.write(
    path.join(pipelineDir, "sink.yaml"),
    `name: widgets_sink
database: source-db
table: public.Widget
batch_size: 50
status: active
actions:
- insert
- update
- delete
destination:
  type: elasticsearch
  endpoint_url: http://opensearch:9200
  index_name: widgets
  auth_type: basic
  auth_value: admin:admin
  batch_size: 100
transform: widgets-transform
enrichment: widgets-enrichment
`
  );

  await Bun.write(
    path.join(pipelineDir, "index.ts"),
    `export default {
  mappings: { properties: { name: { type: "text" } } },
  settings: { number_of_replicas: "0" },
};
`
  );

  await Bun.write(
    path.join(pipelineDir, "transform.ex"),
    `def transform(_action, record, _changes, _metadata) do
  record
end
`
  );

  await Bun.write(
    path.join(pipelineDir, "enrichment.sql"),
    `SELECT id FROM "Widget" WHERE id = ANY($1);
`
  );
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("infers transform name as <pipeline>-transform", async () => {
  const config = await loadPipeline("widgets", tmpDir);
  expect(config.transform.name).toBe("widgets-transform");
  expect(config.transform.id).toBe("widgets-transform");
});

test("infers enrichment name as <pipeline>-enrichment", async () => {
  const config = await loadPipeline("widgets", tmpDir);
  expect(config.enrichment.name).toBe("widgets-enrichment");
  expect(config.enrichment.id).toBe("widgets-enrichment");
});

test("reads transform.ex code directly", async () => {
  const config = await loadPipeline("widgets", tmpDir);
  expect(config.transform.functionBody).toContain("def transform");
});

test("reads enrichment.sql code directly", async () => {
  const config = await loadPipeline("widgets", tmpDir);
  expect(config.enrichment.source).toContain("SELECT id FROM");
});

test("sets transform/enrichment ids on sink config", async () => {
  const config = await loadPipeline("widgets", tmpDir);
  expect(config.sink.transformId).toBe("widgets-transform");
  expect(config.sink.enrichmentIds).toEqual(["widgets-enrichment"]);
});

test("loads full pipeline without transform.yaml or enrichment.yaml", async () => {
  const config = await loadPipeline("widgets", tmpDir);

  expect(config.name).toBe("widgets");
  expect(config.sink.name).toBe("widgets_sink");
  expect(config.sink.sourceTable).toBe("public.Widget");
  expect(config.index.mappings).toEqual({ properties: { name: { type: "text" } } });
  expect(config.transform.functionBody).toContain("record");
  expect(config.enrichment.source).toContain("Widget");
});

test("loadSrbConfig: falls back to ALL_COLORS when _srb.yaml is absent", async () => {
  const dir = path.join(tmpDir, ".no-srb-yaml");
  await fs.mkdir(dir, { recursive: true });
  const { colors } = await loadSrbConfig(dir);
  expect(colors).toEqual(ALL_COLORS);
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadSrbConfig: reads colors allowlist from _srb.yaml", async () => {
  const dir = path.join(tmpDir, ".with-srb-yaml");
  await fs.mkdir(dir, { recursive: true });
  await Bun.write(
    path.join(dir, "_srb.yaml"),
    `colors:\n  - blue\n  - green\n  - purple\n`,
  );
  const { colors } = await loadSrbConfig(dir);
  expect(colors).toEqual(["blue", "green", "purple"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadSrbConfig: rejects invalid color names", async () => {
  const dir = path.join(tmpDir, ".bad-srb-yaml");
  await fs.mkdir(dir, { recursive: true });
  await Bun.write(path.join(dir, "_srb.yaml"), `colors:\n  - mauve\n`);
  await expect(loadSrbConfig(dir)).rejects.toThrow(/invalid color/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadSrbConfig: empty/missing colors list falls back to ALL_COLORS", async () => {
  const dir = path.join(tmpDir, ".empty-srb-yaml");
  await fs.mkdir(dir, { recursive: true });
  await Bun.write(path.join(dir, "_srb.yaml"), `colors: []\n`);
  const { colors } = await loadSrbConfig(dir);
  expect(colors).toEqual(ALL_COLORS);
  await fs.rm(dir, { recursive: true, force: true });
});
