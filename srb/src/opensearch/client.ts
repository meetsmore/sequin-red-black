/**
 * OpenSearch omits "type": "object" for fields that have "properties".
 * Add it back to nested fields so desired vs live comparison doesn't
 * produce false diffs. Does NOT add it to the root mappings object.
 */
function normalizeMappingTypes(mappings: Record<string, unknown>): void {
  const props = mappings.properties as Record<string, unknown> | undefined;
  if (!props || typeof props !== "object") return;
  for (const field of Object.values(props)) {
    normalizeFieldType(field);
  }
}

function normalizeFieldType(field: unknown): void {
  if (!field || typeof field !== "object" || Array.isArray(field)) return;
  const rec = field as Record<string, unknown>;
  if (rec.properties && typeof rec.properties === "object") {
    if (!rec.type) {
      rec.type = "object";
    }
    const props = rec.properties as Record<string, unknown>;
    for (const val of Object.values(props)) {
      normalizeFieldType(val);
    }
  }
}

/** Recursively coerce numeric strings to numbers in an object tree */
function deepCoerceNumbers(obj: unknown): unknown {
  if (typeof obj === "string" && /^\d+$/.test(obj)) return Number(obj);
  if (Array.isArray(obj)) return obj.map(deepCoerceNumbers);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = deepCoerceNumbers(v);
    }
    return result;
  }
  return obj;
}

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
    // Delete first if exists — makes apply idempotent after partial failures
    await this.deleteIndex(name);
    const res = await this.fetch(`/${name}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenSearch PUT /${name}: ${res.status} ${await res.text()}`);
    }
  }

  async getIndexMappings(name: string): Promise<Record<string, unknown>> {
    const res = await this.fetch(`/${name}/_mapping`);
    if (!res.ok) return {};
    const data = (await res.json()) as Record<string, { mappings?: Record<string, unknown> }>;
    const mappings = data[name]?.mappings ?? {};
    // OpenSearch omits "type": "object" from fields with "properties" since
    // it's the default. Add it back so comparison with desired config works.
    normalizeMappingTypes(mappings);
    return mappings;
  }

  /**
   * Get index settings, filtered to only include keys present in desiredSettings.
   * This avoids false diffs from OS defaults (number_of_replicas, etc.) that
   * weren't explicitly set by the user.
   */
  async getIndexSettings(name: string, desiredSettings?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.fetch(`/${name}/_settings`);
    if (!res.ok) return {};
    const data = (await res.json()) as Record<string, { settings?: Record<string, unknown> }>;
    const indexSettings = ((data[name]?.settings ?? {}) as Record<string, unknown>).index as Record<string, unknown> | undefined;
    if (!indexSettings) return {};

    // Only return settings whose keys exist in the desired config.
    // This prevents false diffs from OS defaults like number_of_replicas.
    const desiredKeys = desiredSettings ? new Set(Object.keys(desiredSettings)) : null;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(indexSettings)) {
      // Skip if not in desired config (when desired is provided)
      if (desiredKeys && !desiredKeys.has(key)) continue;

      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        // Match type to desired value for accurate comparison.
        // OS stores numbers as strings (e.g. "0"), desired may have string "0" or number 0.
        const desiredVal = desiredSettings?.[key];
        if (desiredVal !== undefined && typeof desiredVal === "string") {
          result[key] = String(value);
        } else if (typeof value === "string" && /^\d+$/.test(value)) {
          result[key] = Number(value);
        } else {
          result[key] = value;
        }
      } else if (typeof value === "object" && value !== null) {
        result[key] = deepCoerceNumbers(value);
      }
    }

    // Handle nested "index" key from desired: { index: { max_result_window: 100000 } }
    // OS stores these flat under index.*, so we need to pick them out
    if (desiredKeys?.has("index") && desiredSettings?.index) {
      const desiredIdx = desiredSettings.index as Record<string, unknown>;
      const resultIdx: Record<string, unknown> = {};
      for (const subKey of Object.keys(desiredIdx)) {
        if (subKey in indexSettings) {
          const v = indexSettings[subKey];
          resultIdx[subKey] = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
        }
      }
      if (Object.keys(resultIdx).length > 0) result.index = resultIdx;
    }

    return result;
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
