export class OpenSearchClient {
  constructor(
    private baseUrl: string,
    private auth?: { user: string; password: string },
  ) {}

  private authHeaders(): Record<string, string> {
    if (!this.auth) return {};
    const encoded = btoa(`${this.auth.user}:${this.auth.password}`);
    return { Authorization: `Basic ${encoded}` };
  }

  private async fetch(path: string, opts?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
        ...opts?.headers,
      },
    });
    return res;
  }

  async listIndices(): Promise<{ name: string; health: string; docCount: number }[]> {
    const res = await this.fetch("/_cat/indices?format=json");
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

  async getAlias(aliasName: string): Promise<string | null> {
    const res = await this.fetch(`/_alias/${aliasName}`);
    if (res.status === 404) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const indices = Object.keys(data);
    return indices.length > 0 ? indices[0] : null;
  }

  async swapAlias(aliasName: string, from: string | null, to: string): Promise<void> {
    const actions: unknown[] = [{ add: { index: to, alias: aliasName } }];
    if (from) actions.unshift({ remove: { index: from, alias: aliasName } });
    const res = await this.fetch("/_aliases", {
      method: "POST",
      body: JSON.stringify({ actions }),
    });
    if (!res.ok) {
      throw new Error(`OpenSearch swap alias: ${res.status} ${await res.text()}`);
    }
  }

  async triggerReindex(source: string, target: string): Promise<void> {
    const res = await this.fetch("/_reindex?wait_for_completion=false", {
      method: "POST",
      body: JSON.stringify({
        source: { index: source },
        dest: { index: target },
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenSearch reindex: ${res.status} ${await res.text()}`);
    }
  }
}
