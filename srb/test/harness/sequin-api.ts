import { SinkListSchema, type SinkInfo } from "../../src/sequin/schemas.js";

export class TestSequinClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async fetch(path: string, opts?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    });
  }

  async listSinks(): Promise<SinkInfo[]> {
    const res = await this.fetch("/api/sinks");
    if (!res.ok) {
      throw new Error(`Sequin API GET /api/sinks: ${res.status} ${await res.text()}`);
    }
    const data = SinkListSchema.parse(await res.json());
    return data.data;
  }

  async getSinkByName(name: string): Promise<SinkInfo | null> {
    const sinks = await this.listSinks();
    return sinks.find((s) => s.name === name) ?? null;
  }

  async deleteSink(sinkId: string): Promise<void> {
    const res = await this.fetch(`/api/sinks/${sinkId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Sequin API DELETE /api/sinks/${sinkId}: ${res.status} ${await res.text()}`);
    }
  }

  async deleteAllSinks(): Promise<void> {
    const sinks = await this.listSinks();
    for (const sink of sinks) {
      await this.deleteSink(sink.id);
    }
  }

  async triggerBackfill(sinkId: string): Promise<void> {
    const res = await this.fetch(`/api/sinks/${sinkId}/backfills`, { method: "POST", body: "{}" });
    if (!res.ok) {
      throw new Error(
        `Sequin API POST /api/sinks/${sinkId}/backfills: ${res.status} ${await res.text()}`,
      );
    }
  }
}
