import { loadAll } from "../config/loader.js";

export async function compile(indexesDir: string, outPath: string): Promise<void> {
  const pipelines = await loadAll(indexesDir);
  const obj = Object.fromEntries(pipelines);
  await Bun.write(outPath, JSON.stringify(obj, null, 2));
  console.log(`Compiled ${pipelines.size} pipeline(s) → ${outPath}`);
}
