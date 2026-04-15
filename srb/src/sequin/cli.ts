import * as yaml from "js-yaml";

export interface SequinCLIOptions {
  context?: string;
}

export interface SequinConfigYaml {
  sinks?: unknown[];
  functions?: unknown[];
  [key: string]: unknown;
}

export class SequinCLI {
  constructor(private opts: SequinCLIOptions = {}) {}

  private contextArgs(): string[] {
    return this.opts.context ? ["--context", this.opts.context] : [];
  }

  async plan(yamlPath: string): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["sequin", "config", "plan", yamlPath, ...this.contextArgs()], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  }

  async apply(yamlPath: string): Promise<void> {
    const proc = Bun.spawn(["sequin", "config", "apply", yamlPath, "--auto-approve", ...this.contextArgs()], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`sequin config apply failed (exit ${exitCode})`);
    }
  }

  async export_(): Promise<SequinConfigYaml> {
    const proc = Bun.spawn(["sequin", "config", "export", ...this.contextArgs()], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`sequin config export failed (exit ${exitCode}): ${stderr}`);
    }
    return yaml.load(stdout) as SequinConfigYaml;
  }
}
