import { loadAllWithConfig } from "../config/loader.js";

export async function compile(indexesDir: string, outPath: string): Promise<void> {
  const { colors, pipelines } = await loadAllWithConfig(indexesDir);
  const obj = { colors, pipelines: Object.fromEntries(pipelines) };
  await Bun.write(outPath, JSON.stringify(obj, null, 2));
  console.log(`Compiled ${pipelines.size} pipeline(s), colors=[${colors.join(", ")}] → ${outPath}`);
}
