import { SequinCLI } from "../sequin/cli.js";
import { SequinAPI } from "../sequin/api.js";
import { OpenSearchClient } from "../opensearch/client.js";
import type { PipelineConfig } from "../config/types.js";

export interface OnlineOptions {
  compiled: string;
  sequinContext?: string;
  sequinUrl: string;
  sequinToken: string;
  opensearchUrl: string;
  opensearchUser?: string;
  opensearchPassword?: string;
}

export function createClients(opts: OnlineOptions) {
  const sequinCli = new SequinCLI({ context: opts.sequinContext });
  const sequinApi = new SequinAPI(opts.sequinUrl, opts.sequinToken);
  const openSearch = new OpenSearchClient(
    opts.opensearchUrl,
    opts.opensearchUser && opts.opensearchPassword
      ? { user: opts.opensearchUser, password: opts.opensearchPassword }
      : undefined,
  );
  return { sequinCli, sequinApi, openSearch };
}

export async function loadCompiled(compiledPath: string): Promise<Map<string, PipelineConfig>> {
  const text = await Bun.file(compiledPath).text();
  const obj = JSON.parse(text) as Record<string, PipelineConfig>;
  return new Map(Object.entries(obj));
}
