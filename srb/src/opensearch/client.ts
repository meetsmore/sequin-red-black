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
    const res = await this.fetch(`/${name}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      // If index already exists (e.g. from a partial failed apply), skip
      if (res.status === 400 && text.includes("resource_already_exists_exception")) {
        return;
      }
      throw new Error(`OpenSearch PUT /${name}: ${res.status} ${text}`);
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

  async getDocCount(index: string): Promise<number> {
    const res = await this.fetch(`/${index}/_count`);
    if (!res.ok) {
      throw new Error(`OpenSearch GET /${index}/_count: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { count: number };
    return data.count;
  }

  /**
   * Scroll through all documents in an index, yielding batches.
   * Each batch is a Map from _id to _source.
   * @param batchSize Number of docs per scroll page
   */
  async *scrollDocs(
    index: string,
    batchSize = 1000,
  ): AsyncGenerator<Map<string, Record<string, unknown>>> {
    // Initial search with scroll
    const res = await this.fetch(`/${index}/_search?scroll=2m`, {
      method: "POST",
      body: JSON.stringify({
        size: batchSize,
        sort: ["_doc"],
        query: { match_all: {} },
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenSearch scroll init /${index}: ${res.status} ${await res.text()}`);
    }

    let data = (await res.json()) as {
      _scroll_id: string;
      hits: { hits: { _id: string; _source: Record<string, unknown> }[] };
    };

    while (data.hits.hits.length > 0) {
      const batch = new Map<string, Record<string, unknown>>();
      for (const hit of data.hits.hits) {
        batch.set(hit._id, hit._source);
      }
      yield batch;

      // Fetch next page
      const scrollRes = await this.fetch("/_search/scroll", {
        method: "POST",
        body: JSON.stringify({
          scroll: "2m",
          scroll_id: data._scroll_id,
        }),
      });
      if (!scrollRes.ok) break;
      data = (await scrollRes.json()) as typeof data;
    }

    // Clean up scroll context
    if (data._scroll_id) {
      await this.fetch("/_search/scroll", {
        method: "DELETE",
        body: JSON.stringify({ scroll_id: [data._scroll_id] }),
      }).catch(() => {});
    }
  }

  /**
   * Read index.max_result_window (default 10000). Used to decide whether
   * a sample fits in a single search or needs PIT + search_after pagination.
   */
  async getMaxResultWindow(index: string): Promise<number> {
    const res = await this.fetch(`/${index}/_settings?include_defaults=true&flat_settings=true`);
    if (!res.ok) return 10000;
    const data = (await res.json()) as Record<string, {
      settings?: Record<string, unknown>;
      defaults?: Record<string, unknown>;
    }>;
    const entry = data[index];
    const raw = entry?.settings?.["index.max_result_window"]
      ?? entry?.defaults?.["index.max_result_window"];
    const n = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  /**
   * Randomly sample up to `targetCount` documents from an index using
   * OpenSearch-side random_score, avoiding the need to transfer the whole
   * dataset. Uses a single _search for small samples; otherwise paginates
   * via PIT + search_after with a deterministic random score so pages
   * don't overlap. The single-search threshold is intentionally
   * conservative (SAFE_PAGE_SIZE) rather than index.max_result_window,
   * because large single responses can exceed proxy/LB buffer or timeout
   * limits and surface as 502 Bad Gateway even when OpenSearch would
   * have accepted the request.
   */
  async sampleDocs(
    index: string,
    targetCount: number,
    seed: number = Math.floor(Math.random() * 2 ** 31),
  ): Promise<Map<string, Record<string, unknown>>> {
    const result = new Map<string, Record<string, unknown>>();
    for await (const batch of this.sampleDocsBatched(index, targetCount, seed)) {
      for (const [id, doc] of batch) result.set(id, doc);
    }
    return result;
  }

  /**
   * Streaming variant of `sampleDocs` — yields batches of up to ~pageSize
   * randomly-sampled docs so callers can process and discard them without
   * materialising the full sample in memory.
   */
  async *sampleDocsBatched(
    index: string,
    targetCount: number,
    seed: number = Math.floor(Math.random() * 2 ** 31),
  ): AsyncGenerator<Map<string, Record<string, unknown>>> {
    if (targetCount <= 0) return;

    const SAFE_PAGE_SIZE = 10000;
    const maxWindow = await this.getMaxResultWindow(index);
    const pageSize = Math.min(SAFE_PAGE_SIZE, maxWindow);

    const scoreQuery = {
      function_score: {
        query: { match_all: {} },
        random_score: { seed, field: "_seq_no" },
        boost_mode: "replace",
      },
    };

    if (targetCount <= pageSize) {
      const res = await this.fetch(`/${index}/_search`, {
        method: "POST",
        body: JSON.stringify({ size: targetCount, query: scoreQuery }),
      });
      if (!res.ok) {
        throw new Error(`OpenSearch sample /${index}: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as {
        hits: { hits: { _id: string; _source: Record<string, unknown> }[] };
      };
      const batch = new Map<string, Record<string, unknown>>();
      for (const hit of data.hits.hits) batch.set(hit._id, hit._source);
      if (batch.size > 0) yield batch;
      return;
    }

    // Large N: open a PIT and paginate by the (deterministic) random score.
    const pitRes = await this.fetch(`/${index}/_search/point_in_time?keep_alive=5m`, {
      method: "POST",
    });
    if (!pitRes.ok) {
      throw new Error(`OpenSearch PIT /${index}: ${pitRes.status} ${await pitRes.text()}`);
    }
    let pitId = ((await pitRes.json()) as { pit_id: string }).pit_id;

    try {
      let searchAfter: unknown[] | undefined;
      let yielded = 0;
      while (yielded < targetCount) {
        const body: Record<string, unknown> = {
          size: Math.min(pageSize, targetCount - yielded),
          pit: { id: pitId, keep_alive: "5m" },
          query: scoreQuery,
          sort: [{ _score: "desc" }, { _doc: "asc" }],
          track_scores: true,
        };
        if (searchAfter) body.search_after = searchAfter;

        const res = await this.fetch(`/_search`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(`OpenSearch sample search: ${res.status} ${await res.text()}`);
        }
        const data = (await res.json()) as {
          pit_id?: string;
          hits: { hits: { _id: string; _source: Record<string, unknown>; sort?: unknown[] }[] };
        };
        if (data.pit_id) pitId = data.pit_id;

        const hits = data.hits.hits;
        if (hits.length === 0) break;
        const batch = new Map<string, Record<string, unknown>>();
        for (const hit of hits) batch.set(hit._id, hit._source);
        yield batch;
        yielded += batch.size;
        searchAfter = hits[hits.length - 1]!.sort;
      }
    } finally {
      await this.fetch(`/_search/point_in_time`, {
        method: "DELETE",
        body: JSON.stringify({ pit_id: pitId }),
      }).catch(() => {});
    }
  }

  /**
   * Fetch specific documents by _id from an index.
   * Returns a Map from _id to _source.
   */
  async getDocsByIds(
    index: string,
    ids: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    if (ids.length === 0) return new Map();
    const res = await this.fetch(`/${index}/_mget`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      throw new Error(`OpenSearch _mget /${index}: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      docs: { _id: string; found: boolean; _source?: Record<string, unknown> }[];
    };
    const result = new Map<string, Record<string, unknown>>();
    for (const doc of data.docs) {
      if (doc.found && doc._source) {
        result.set(doc._id, doc._source);
      }
    }
    return result;
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
