import { SinkListSchema, SinkInfoSchema, type SinkInfo } from "./schemas.js";

export class SequinAPI {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async fetch(path: string, opts?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    });
    if (!res.ok) {
      throw new Error(
        `Sequin API ${opts?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`,
      );
    }
    return res;
  }

  async listSinks(): Promise<SinkInfo[]> {
    const res = await this.fetch("/api/sinks");
    const data = SinkListSchema.parse(await res.json());
    return data.data;
  }

  async getSink(id: string): Promise<SinkInfo> {
    const res = await this.fetch(`/api/sinks/${id}`);
    return SinkInfoSchema.parse(await res.json());
  }

  async deleteSink(sinkId: string): Promise<void> {
    await this.fetch(`/api/sinks/${sinkId}`, { method: "DELETE" });
  }

  async triggerBackfill(sinkId: string): Promise<void> {
    await this.fetch(`/api/sinks/${sinkId}/backfills`, { method: "POST", body: "{}" });
  }

  /** List all functions (transforms + enrichments). Returns array of {id, name, ...}. */
  async listFunctions(): Promise<{ id: string; name: string }[]> {
    const res = await this.fetch("/api/functions");
    const data = (await res.json()) as { data: { id: string; name: string }[] };
    return data.data;
  }

  async deleteFunction(functionId: string): Promise<void> {
    await this.fetch(`/api/functions/${functionId}`, { method: "DELETE" });
  }
}
