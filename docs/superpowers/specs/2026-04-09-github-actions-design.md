# GitHub Actions Design for srb

Reusable GitHub Actions workflows so that any repo can run `srb` commands against their own pipeline configs.

## Architecture

This repo (`sequin-red-black-v2`) provides:

1. **A release workflow** that compiles `srb` binaries for linux/amd64 and linux/arm64 and publishes them as GitHub Release assets.
2. **Four reusable workflows** (`workflow_call`) that consuming repos invoke to run srb commands. Each is also manually triggerable via `workflow_dispatch`.

Consuming repos contain their own `indexes/` directory with pipeline configs. They call the reusable workflows, passing connection details and secrets.

## Release workflow

**File:** `.github/workflows/release.yml`

**Trigger:** `workflow_dispatch` with a required `version` input (e.g. `v0.1.0`).

**Jobs:** A matrix build with two targets:

| Target | Runner | Bun target flag | Artifact name |
|--------|--------|----------------|---------------|
| linux/amd64 | `ubuntu-latest` | `--target=bun-linux-x64` | `srb-linux-amd64` |
| linux/arm64 | arm64 runner | `--target=bun-linux-arm64` | `srb-linux-arm64` |

**Steps per matrix job:**
1. Checkout this repo
2. Install Bun
3. `cd srb && bun install`
4. `bun build --compile --target=<target> src/cli.ts --outfile srb-linux-<arch>`
5. Upload artifact

**Final job** (after matrix completes):
1. Download both artifacts
2. Create GitHub Release tagged with the version input
3. Attach both binaries to the release

## Reusable workflows

### Shared setup

Every reusable workflow performs these steps before running its command:

1. **Checkout caller's repo** — `actions/checkout@v4` (default behavior with `workflow_call`)
2. **Install Sequin CLI** — `curl -sf https://raw.githubusercontent.com/sequinstream/sequin/main/cli/installer.sh | sh`
3. **Download srb binary** — from this repo's GitHub Releases, selecting the correct binary based on `runner.arch`. Version is pinnable via `srb-version` input (default: `latest`).
4. **Compile** — `srb offline compile --indexes <indexes-dir> --out compiled.json`
5. **Set connection env vars** — map inputs/secrets to `SRB_*` environment variables

### Shared inputs

All four reusable workflows accept these inputs:

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `indexes-dir` | string | no | `./indexes` | Path to pipeline config directory |
| `srb-version` | string | no | `latest` | Version of srb to download |
| `sequin-url` | string | yes | | Sequin API URL |
| `sequin-context` | string | no | | Sequin CLI context |
| `opensearch-url` | string | yes | | OpenSearch URL |
| `opensearch-user` | string | no | | OpenSearch user |

### Shared secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `sequin-token` | yes | Sequin API token |
| `opensearch-password` | no | OpenSearch password |

### plan.yml

**File:** `.github/workflows/plan.yml`

**Additional inputs:**

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `apply` | boolean | no | `false` | Run apply instead of plan |
| `auto-approve` | boolean | no | `true` | Skip confirmation (for apply) |

**Command:**
- When `apply` is false: `srb online plan`
- When `apply` is true: `srb online apply --auto-approve` (if auto-approve is true)

### activate.yml

**File:** `.github/workflows/activate.yml`

**Additional inputs:**

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pipeline` | string | yes | | Pipeline name |
| `color` | string | yes | | Color to activate |

**Command:** `srb online activate <pipeline> <color>`

### drop.yml

**File:** `.github/workflows/drop.yml`

**Additional inputs:**

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pipeline` | string | yes | | Pipeline name |
| `color` | string | yes | | Color to drop |

**Command:** `srb online drop <pipeline> <color>`

### backfill.yml

**File:** `.github/workflows/backfill.yml`

**Additional inputs:**

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pipeline` | string | yes | | Pipeline name |
| `color` | string | yes | | Color to backfill |

**Command:** `srb online backfill <pipeline> <color>`

## Consumer usage example

A consuming repo's workflow to plan changes:

```yaml
name: SRB Plan
on:
  workflow_dispatch:

jobs:
  plan:
    uses: your-org/sequin-red-black-v2/.github/workflows/plan.yml@v1
    with:
      indexes-dir: ./indexes
      sequin-url: https://sequin.example.com
      opensearch-url: https://opensearch.example.com
    secrets:
      sequin-token: ${{ secrets.SEQUIN_TOKEN }}
      opensearch-password: ${{ secrets.OPENSEARCH_PASSWORD }}
```

## Dependencies

- **Bun** — used in release workflow to compile the binary
- **Sequin CLI** — installed in reusable workflows via the official installer script
- **GitHub Releases** — hosts the compiled srb binaries
