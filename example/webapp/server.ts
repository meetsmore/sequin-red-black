import { SQL } from "bun";
import index from "./index.html";

const sql = new SQL({
  url: "postgres://postgres:postgres@localhost:7377/source",
});

const OPENSEARCH_URL = "http://localhost:9200";

Bun.serve({
  port: 3000,
  routes: {
    "/": index,

    // --- Table data ---
    // Jobs and Clients are read from OpenSearch (the indexed view).
    // Divisions are read from Postgres (reference data, not indexed).
    // Writes always go to Postgres (Sequin CDC syncs to OpenSearch).

    "/api/tables/:table": {
      async GET(req) {
        const table = req.params.table;
        if (!["Job", "Client", "Division"].includes(table)) {
          return Response.json({ error: "Unknown table" }, { status: 400 });
        }

        // Divisions are reference data — read from Postgres
        if (table === "Division") {
          const rows = await sql.unsafe(`SELECT * FROM public."${table}" ORDER BY id`);
          return Response.json(rows);
        }

        // Jobs and Clients are read from OpenSearch
        const index = table === "Job" ? "jobs" : "clients";
        const osResp = await fetch(`${OPENSEARCH_URL}/${index}/_search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: { match_all: {} }, size: 1000, sort: [{ id: { order: "asc" } }] }),
        });
        if (!osResp.ok) {
          return Response.json({ error: "OpenSearch unavailable" }, { status: 502 });
        }
        const data = await osResp.json() as { hits: { hits: Array<{ _source: Record<string, unknown> }> } };
        const rows = data.hits.hits.map(h => h._source);
        return Response.json(rows);
      },
      async POST(req) {
        const table = req.params.table;
        if (!["Job", "Client"].includes(table)) {
          return Response.json({ error: "Unknown table" }, { status: 400 });
        }
        const body = await req.json() as Record<string, unknown>;
        // Get writable columns (exclude id, created_at, updated_at)
        const colRows = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table}
            AND column_name NOT IN ('id', 'createdAt', 'updatedAt')
          ORDER BY ordinal_position
        `;
        const cols = colRows.map((r: Record<string, string>) => r.column_name).filter((c: string) => body[c] !== undefined);
        if (cols.length === 0) return Response.json({ error: "No valid columns" }, { status: 400 });

        const colList = cols.map((c: string) => `"${c}"`).join(", ");
        const placeholders = cols.map((_: string, i: number) => `$${i + 1}`).join(", ");
        const values = cols.map((c: string) => body[c]);

        const rows = await sql.unsafe(
          `INSERT INTO public."${table}" (${colList}) VALUES (${placeholders}) RETURNING *`,
          values,
        );
        return Response.json(rows[0], { status: 201 });
      },
    },

    "/api/tables/:table/:id": {
      async PUT(req) {
        const table = req.params.table;
        if (!["Job", "Client"].includes(table)) {
          return Response.json({ error: "Unknown table" }, { status: 400 });
        }
        const id = parseInt(req.params.id);
        const body = await req.json() as Record<string, unknown>;

        // Get writable columns
        const colRows = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table}
            AND column_name NOT IN ('id', 'createdAt', 'updatedAt')
          ORDER BY ordinal_position
        `;
        const cols = colRows.map((r: Record<string, string>) => r.column_name).filter((c: string) => body[c] !== undefined);
        if (cols.length === 0) return Response.json({ error: "No valid columns" }, { status: 400 });

        const setClause = cols.map((c: string, i: number) => `"${c}" = $${i + 1}`).join(", ");
        const values = cols.map((c: string) => body[c]);
        values.push(id);

        const rows = await sql.unsafe(
          `UPDATE public."${table}" SET ${setClause}, "updatedAt" = now() WHERE id = $${values.length} RETURNING *`,
          values,
        );
        if (rows.length === 0) return new Response("Not found", { status: 404 });
        return Response.json(rows[0]);
      },
      async DELETE(req) {
        const table = req.params.table;
        if (!["Job", "Client"].includes(table)) {
          return Response.json({ error: "Unknown table" }, { status: 400 });
        }
        const id = parseInt(req.params.id);
        await sql.unsafe(`DELETE FROM public."${table}" WHERE id = $1`, [id]);
        return new Response(null, { status: 204 });
      },
    },

    // --- Schema / Migrations ---

    "/api/schema/:table": {
      async GET(req) {
        const table = req.params.table;
        const columns = await sql`
          SELECT column_name, data_type, column_default, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table}
          ORDER BY ordinal_position
        `;
        return Response.json(columns);
      },
    },

    "/api/migrate": {
      async POST(req) {
        const body = await req.json() as { action: string; table: string; column?: string; columnType?: string; defaultValue?: string; fromValue?: string; toValue?: string };
        const { action, table } = body;

        // Only allow migrations on known tables
        if (!["Job", "Client"].includes(table)) {
          return Response.json({ error: "Unknown table" }, { status: 400 });
        }

        switch (action) {
          case "add_column": {
            const { column, columnType, defaultValue } = body;
            if (!column || !columnType) {
              return Response.json({ error: "column and columnType required" }, { status: 400 });
            }
            const defClause = defaultValue != null && defaultValue !== "" ? `DEFAULT '${defaultValue}'` : "";
            await sql.unsafe(`ALTER TABLE public."${table}" ADD COLUMN IF NOT EXISTS "${column}" ${columnType} ${defClause}`);
            // Touch all rows so CDC picks up the change
            await sql.unsafe(`UPDATE public."${table}" SET "updatedAt" = now()`);
            return Response.json({ ok: true, message: `Added column "${column}" to ${table}` });
          }

          case "drop_column": {
            const { column } = body;
            if (!column) {
              return Response.json({ error: "column required" }, { status: 400 });
            }
            // Prevent dropping essential columns
            const protected_columns = ["id", "createdAt", "updatedAt"];
            if (protected_columns.includes(column)) {
              return Response.json({ error: `Cannot drop protected column "${column}"` }, { status: 400 });
            }
            await sql.unsafe(`ALTER TABLE public."${table}" DROP COLUMN IF EXISTS "${column}"`);
            await sql.unsafe(`UPDATE public."${table}" SET "updatedAt" = now()`);
            return Response.json({ ok: true, message: `Dropped column "${column}" from ${table}` });
          }

          case "rename_values": {
            const { column, fromValue, toValue } = body;
            if (!column || fromValue == null || toValue == null) {
              return Response.json({ error: "column, fromValue, and toValue required" }, { status: 400 });
            }
            const result = await sql.unsafe(
              `UPDATE public."${table}" SET "${column}" = $1, "updatedAt" = now() WHERE "${column}" = $2`,
              [toValue, fromValue],
            );
            return Response.json({ ok: true, message: `Renamed "${fromValue}" → "${toValue}" in ${table}.${column} (${result.length} rows)` });
          }

          default:
            return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
        }
      },
    },

    // --- OpenSearch Indexes & Aliases ---

    "/api/indexes": {
      async GET() {
        const [aliasResp, catResp] = await Promise.all([
          fetch(`${OPENSEARCH_URL}/_aliases`),
          fetch(`${OPENSEARCH_URL}/_cat/indices?format=json&h=index,docs.count,health,status`),
        ]);

        if (!aliasResp.ok || !catResp.ok) {
          return Response.json({ indexes: [], aliases: [] }, { status: 502 });
        }

        const aliasData = await aliasResp.json() as Record<string, { aliases: Record<string, unknown> }>;
        const catData = await catResp.json() as Array<{ index: string; "docs.count": string; health: string; status: string }>;

        // Build alias → index[] mapping
        const aliasMap: Record<string, string[]> = {};
        for (const [indexName, meta] of Object.entries(aliasData)) {
          for (const alias of Object.keys(meta.aliases ?? {})) {
            if (!aliasMap[alias]) aliasMap[alias] = [];
            aliasMap[alias].push(indexName);
          }
        }

        // Filter to non-hidden indexes
        const indexes = catData
          .filter(i => !i.index.startsWith("."))
          .map(i => ({
            name: i.index,
            docsCount: parseInt(i["docs.count"]) || 0,
            health: i.health,
            status: i.status,
          }));

        const aliases = Object.entries(aliasMap).map(([alias, targets]) => ({
          name: alias,
          indexes: targets,
        }));

        return Response.json({ indexes, aliases });
      },
    },

    // --- OpenSearch Search ---

    "/api/search": {
      async GET(req) {
        const url = new URL(req.url);
        const q = url.searchParams.get("q") ?? "";
        const idx = url.searchParams.get("index") ?? "jobs";

        if (!q) return Response.json({ hits: [] });

        const osResp = await fetch(`${OPENSEARCH_URL}/${idx}/_search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: {
              multi_match: {
                query: q,
                fields: ["*"],
                type: "best_fields",
                fuzziness: "AUTO",
              },
            },
            size: 50,
          }),
        });

        if (!osResp.ok) {
          const err = await osResp.text();
          return Response.json({ error: err, hits: [] }, { status: 502 });
        }

        const data = await osResp.json();
        const hits = (data.hits?.hits ?? []).map((h: { _index: string; _id: string; _score: number; _source: Record<string, unknown> }) => ({
          index: h._index,
          id: h._id,
          score: h._score,
          ...h._source,
        }));

        return Response.json({ hits, total: data.hits?.total?.value ?? hits.length });
      },
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log("Demo webapp running at http://localhost:3000");
