# srb — Red-Black Deployment Orchestrator

A stateless CLI tool that manages red-black (blue-green) deployments of CDC pipelines from Postgres through [Sequin](https://sequinstream.com) to OpenSearch.

## What it does

`srb` orchestrates zero-downtime deployments of search indexes. When you change a pipeline's config (transform logic, index mappings, enrichment queries), `srb` creates a new colored variant alongside the existing one, backfills data, then atomically swaps the alias.

```
                    ┌─────────────┐
                    │  Postgres   │
                    │  (source)   │
                    └──────┬──────┘
                           │ CDC
                    ┌──────▼──────┐
                    │   Sequin    │
                    │  (sinks)    │
                    └──────┬──────┘
                       ┌───┴───┐
                 ┌─────▼─┐   ┌─▼─────┐
                 │jobs_red│   │jobs_   │
                 │(active)│   │black   │
                 └────┬───┘   │(new)   │
                      │       └────────┘
              ┌───────▼───────┐
              │  alias: jobs  │ ← srb activate swaps this
              └───────────────┘
```

Each pipeline bundles four resources:
- **Sequin sink** — CDC consumer that reads from Postgres
- **OpenSearch index** — where documents land
- **Transform** — Elixir function that shapes each record
- **Enrichment** — SQL query that joins additional data

## Example walkthrough

This walks through a complete red-black deployment using the included example stack.

### Prerequisites

- [Bun](https://bun.sh)
- [Docker](https://docker.com)
- [Sequin CLI](https://sequinstream.com/docs/cli)

### 1. Start the stack

```bash
bunx kadai run example/setup
```

This starts Postgres, Redis, Sequin, OpenSearch, and a demo webapp. Once complete you'll see:

```
Services:
  Sequin:      http://localhost:7376  (admin@example.com / sequinpassword!)
  OpenSearch:  http://localhost:9200
  Postgres:    localhost:7377  (postgres / postgres)
  Webapp:      http://localhost:3000
```

The Postgres database comes pre-loaded with sample Jobs, Clients, and Divisions.

### 2. Deploy the initial pipelines

First, see what `srb` would do:

```bash
bunx kadai run example/plan
```

This compiles the pipeline configs in `example/indexes/` and diffs them against live state. Since nothing is deployed yet, you'll see two "new pipeline" plans (jobs + clients) with all-green `+` lines showing the full config.

Apply the plan:

```bash
bunx kadai run example/apply
```

This creates the OpenSearch indices (`jobs_red`, `clients_red`), Sequin sinks, transforms, and enrichments, then triggers backfills to sync data from Postgres.

### 3. Activate the pipelines

The indices exist but the OpenSearch aliases aren't set yet. Activate them:

```bash
bunx kadai run example/activate
# Enter: jobs, red

bunx kadai run example/activate
# Enter: clients, red
```

### 4. View data in the webapp

Open http://localhost:3000. You'll see:

- **Jobs tab** — 10 jobs synced from Postgres through Sequin to OpenSearch, read via the `jobs` alias
- **Clients tab** — 5 clients, same pipeline
- **Indexes tab** — shows `jobs_red` and `clients_red` with doc counts and alias assignments
- **Search tab** — full-text search across OpenSearch indices

The webapp reads from OpenSearch (via aliases) and writes to Postgres. Sequin CDC syncs changes automatically — try adding a job in the webapp and watching it appear.

### 5. Make a config change

Edit a transform to change how data flows. For example, modify the jobs transform:

```bash
# example/indexes/jobs/transform.ex
```

Change the transform body — add a field, rename something, change the enrichment logic. Or modify `example/indexes/jobs/index.ts` to change the OpenSearch mappings.

### 6. Plan the update

```bash
bunx kadai run example/plan
```

`srb` detects the change and shows a unified diff of what changed, what strategy it will use, and what effects it will apply:

```
Pipeline: jobs
  Strategy: backfill (transform/enrichment/data changed)
  Target color: black
  Current color: red

  Changes:
    ~ transform "jobs-transform"
        ~ functionBody:
            @@ -1,3 +1,3 @@
             def transform(_action, record, _changes, _metadata) do
            -  record
            +  Map.put(record, "processed", true)
             end

  Effects:
    + create index "jobs_black"
    + create function "jobs_black-transform"
    + create function "jobs_black-enrichment"
    + create sink "jobs_black"
    ~ trigger backfill on "jobs_black"
```

The strategy depends on what changed:
- **Transform/enrichment/data fields** → full backfill (new color, re-sync from Postgres)
- **Index mappings/settings only** → reindex (new color, copy from old index)
- **Operational fields only** (e.g. batch_size) → in-place update (no new color)

### 7. Apply the update

```bash
bunx kadai run example/apply
```

This creates `jobs_black` alongside the existing `jobs_red`. Both are running simultaneously — the alias still points to red, so the webapp sees no change.

You can verify in the Sequin UI at http://localhost:7376 — you'll see both `jobs_red` and `jobs_black` sinks.

### 8. Activate the new color

Once the backfill completes (check sink status in Sequin UI), swap the alias:

```bash
bunx kadai run example/activate
# Enter: jobs, black
```

This atomically points the `jobs` alias from `jobs_red` to `jobs_black`. The webapp instantly reads from the new index — zero downtime.

### 9. Drop the old color

The old `jobs_red` is no longer serving traffic. Clean it up:

```bash
bunx kadai run example/drop
# Enter: jobs, red
```

This deletes the `jobs_red` sink, transform, enrichment, and OpenSearch index.

### 10. Verify

```bash
bunx kadai run example/plan
```

Should show: `No changes. Infrastructure is up to date.`

Only `jobs_black` remains. The next deployment will create `jobs_red` again (or whichever color is available).

### Teardown

```bash
bunx kadai run example/teardown
```

Stops all Docker containers and removes volumes.

## CLI reference

```bash
cd srb && bun install

# Compile per-pipeline configs to a single JSON file
bun run src/cli.ts offline compile --indexes ../example/indexes --out compiled.json

# Plan: diff compiled config vs live state
bun run src/cli.ts online plan --compiled compiled.json \
  --sequin-context srb-local --sequin-url http://localhost:7376 \
  --sequin-token <token> --opensearch-url http://localhost:9200

# Apply: plan + execute
bun run src/cli.ts online apply --compiled compiled.json --auto-approve [--skip-backfill]

# Activate: swap alias to a color
bun run src/cli.ts online activate <pipeline> <color>

# Backfill: manually trigger (when --skip-backfill was used)
bun run src/cli.ts online backfill <pipeline> <color>

# Drop: delete a colored variant
bun run src/cli.ts online drop <pipeline> <color>
```

Exit codes: `0` = success/no changes, `1` = error, `2` = changes pending (plan).

## Pipeline config

Each pipeline lives in its own directory under `indexes/`:

```
indexes/
  jobs/
    index.ts           # OpenSearch mappings + settings (TypeScript)
    sink.yaml          # Sequin sink config
    transform.yaml     # Points to transform.ex
    transform.ex       # Elixir transform function
    enrichment.yaml    # Points to enrichment.sql
    enrichment.sql     # SQL enrichment query
  clients/
    (same structure)
```

`srb offline compile` reads these directories and produces a `compiled.json` that all online commands consume.

## How it works

1. **Compile** — read per-pipeline config directories, produce `compiled.json` (desired state)
2. **Discover** — query Sequin (via CLI export + API) and OpenSearch to build live state
3. **Plan** — diff desired vs live, classify changes by escalation:
   - **Backfill** (hours): transform, enrichment, or data-affecting sink fields changed → create new color, backfill from Postgres
   - **Reindex** (minutes): only index mappings/settings changed → create new color, reindex from old
   - **In-place** (seconds): only operational fields changed (e.g., batch_size) → update existing resources
4. **Execute** — OpenSearch operations directly via REST, Sequin resources via `sequin config apply`, backfill via Sequin API

## Architecture

`srb` uses three interfaces:

| Interface | Used for | Examples |
|-----------|----------|----------|
| Sequin CLI | Declarative resource management | Create/update/delete sinks, transforms, enrichments |
| Sequin REST API | Imperative operations + queries | Trigger backfill, query sink status |
| OpenSearch REST API | Index management | Create/delete indices, swap aliases, reindex |

The tool is stateless — all state is derived from querying Sequin and OpenSearch at runtime.

## Formal specification

The core logic is formally specified in [Quint](https://quint-lang.org) (`docs/spec/quint/`). The TypeScript implementation is a direct translation of the spec. The spec includes:

- **4 invariants** verified by model checking (alias integrity, no partial pipelines, etc.)
- **5 witnesses** proving key states are reachable (deploy, activate, drop, backfill, full cycle)
- **22 tests** covering unit, integration, and end-to-end scenarios

```bash
bunx kadai run quint/check    # Run all Quint checks
```

## Testing

```bash
cd srb

# Unit tests (pure logic, no network)
bun test test/unit/

# E2E tests (requires Docker)
make test-stack-up             # Start test Sequin + OpenSearch
bun test test/e2e/             # Run against real services
make test-stack-down           # Clean up

# All tests
bun test
```

## Naming conventions

Resources are named with a color suffix:

| Resource | Pattern | Example |
|----------|---------|---------|
| Index + Sink | `<pipeline>_<color>` | `jobs_red` |
| Transform | `<pipeline>_<color>-transform` | `jobs_red-transform` |
| Enrichment | `<pipeline>_<color>-enrichment` | `jobs_red-enrichment` |
| Alias | `<pipeline>` (no color) | `jobs` |

7 colors available: red, black, blue, green, purple, orange, yellow.
