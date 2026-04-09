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

  async triggerBackfill(sinkId: string): Promise<void> {
    const res = await this.fetch(`/api/sinks/${sinkId}/backfill`, { method: "POST" });
    if (!res.ok) {
      throw new Error(
        `Sequin API POST /api/sinks/${sinkId}/backfill: ${res.status} ${await res.text()}`,
      );
    }
  }
}
