import type { Color } from "../../src/config/types.js";

const COLOR_SUFFIXES: Color[] = ["red", "black", "blue", "green", "purple", "orange", "yellow"];

export class TestOpenSearchClient {
  constructor(private baseUrl: string) {}

  private async fetch(path: string, opts?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    });
  }

  async listIndices(): Promise<{ name: string; health: string; docCount: number }[]> {
    const res = await this.fetch("/_cat/indices?format=json");
    if (!res.ok) return [];
    const data = (await res.json()) as {
      index: string;
      health: string;
      "docs.count": string;
    }[];
    return data.map((d) => ({
      name: d.index,
      health: d.health,
      docCount: parseInt(d["docs.count"] || "0"),
    }));
  }

  async getAliasColor(pipeline: string): Promise<string | null> {
    const res = await this.fetch(`/_alias/${pipeline}`);
    if (res.status === 404) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const indexName = Object.keys(data)[0];
    if (!indexName) return null;
    // Extract color from index name: "pipeline_color"
    const parts = indexName.split("_");
    return parts[parts.length - 1] ?? null;
  }

  async createIndex(
    name: string,
    body: { mappings: Record<string, unknown>; settings: Record<string, unknown> },
  ): Promise<void> {
    const res = await this.fetch(`/${name}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenSearch PUT /${name}: ${res.status} ${await res.text()}`);
    }
  }

  async deleteIndex(name: string): Promise<void> {
    const res = await this.fetch(`/${name}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`OpenSearch DELETE /${name}: ${res.status}`);
    }
  }

  async deleteAllTestIndices(): Promise<void> {
    const indices = await this.listIndices();
    for (const idx of indices) {
      const isTestIndex = COLOR_SUFFIXES.some((c) => idx.name.endsWith(`_${c}`));
      if (isTestIndex) {
        await this.deleteIndex(idx.name);
      }
    }
  }

  async setAlias(aliasName: string, indexName: string): Promise<void> {
    // First, remove existing alias if any
    const existing = await this.fetch(`/_alias/${aliasName}`);
    const actions: unknown[] = [];

    if (existing.ok) {
      const data = (await existing.json()) as Record<string, unknown>;
      for (const existingIndex of Object.keys(data)) {
        actions.push({ remove: { index: existingIndex, alias: aliasName } });
      }
    }

    actions.push({ add: { index: indexName, alias: aliasName } });

    const res = await this.fetch("/_aliases", {
      method: "POST",
      body: JSON.stringify({ actions }),
    });
    if (!res.ok) {
      throw new Error(`OpenSearch set alias: ${res.status} ${await res.text()}`);
    }
  }
}
