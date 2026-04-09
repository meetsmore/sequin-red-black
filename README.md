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

## Quick start

Prerequisites: [Bun](https://bun.sh), [Docker](https://docker.com), [Sequin CLI](https://sequinstream.com/docs/cli)

```bash
# 1. Start the example stack (Postgres, Sequin, OpenSearch, webapp)
bunx kadai run example/setup

# 2. See what srb would create
bunx kadai run example/plan

# 3. Deploy pipelines
bunx kadai run example/apply

# 4. Activate a pipeline (point alias to colored index)
PIPELINE=jobs COLOR=red bunx kadai run example/activate

# 5. Make a change, deploy new color, swap, drop old
#    (edit example/indexes/jobs/transform.ex, then:)
bunx kadai run example/apply
PIPELINE=jobs COLOR=black bunx kadai run example/activate
PIPELINE=jobs COLOR=red bunx kadai run example/drop
```

The webapp at http://localhost:3000 reads from OpenSearch via the alias, so the swap is invisible to users.

## CLI usage

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
