# GitHub Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create reusable GitHub Actions workflows for srb so any repo can run plan/apply/activate/drop/backfill commands.

**Architecture:** A release workflow compiles srb binaries (linux amd64+arm64) and publishes them as GitHub Release assets. Four reusable workflows download the binary, install the Sequin CLI, compile configs, and run the appropriate srb command. Consuming repos pass an `srb-repo` input (e.g. `myorg/sequin-red-black-v2`) so the download step knows where to fetch binaries from.

**Tech Stack:** GitHub Actions (YAML), Bun (compile step), GitHub CLI (release creation)

---

### Task 1: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the release workflow**

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: "Version tag (e.g. v0.1.0)"
        required: true
        type: string

permissions:
  contents: write

jobs:
  build:
    strategy:
      matrix:
        include:
          - runner: ubuntu-latest
            target: bun-linux-x64
            artifact: srb-linux-amd64
          - runner: ubuntu-24.04-arm
            target: bun-linux-arm64
            artifact: srb-linux-arm64
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: cd srb && bun install
      - run: cd srb && bun build --compile --target=${{ matrix.target }} src/cli.ts --outfile ${{ matrix.artifact }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: srb/${{ matrix.artifact }}

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: srb-linux-amd64
      - uses: actions/download-artifact@v4
        with:
          name: srb-linux-arm64
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ inputs.version }}
          files: |
            srb-linux-amd64
            srb-linux-arm64
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`
Expected: No output (valid YAML)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: add release workflow for srb binaries"
```

### Task 2: Plan/Apply reusable workflow

**Files:**
- Create: `.github/workflows/plan.yml`

- [ ] **Step 1: Create the plan workflow**

```yaml
name: SRB Plan

on:
  workflow_dispatch:
    inputs:
      indexes-dir:
        description: "Path to indexes directory"
        type: string
        default: "./indexes"
      srb-version:
        description: "srb version to download (e.g. v0.1.0)"
        type: string
        default: "latest"
      srb-repo:
        description: "GitHub repo that hosts srb releases (owner/repo)"
        type: string
        required: true
      sequin-url:
        description: "Sequin API URL"
        type: string
        required: true
      sequin-context:
        description: "Sequin CLI context"
        type: string
      opensearch-url:
        description: "OpenSearch URL"
        type: string
        required: true
      opensearch-user:
        description: "OpenSearch user"
        type: string
      apply:
        description: "Run apply instead of plan"
        type: boolean
        default: false
      auto-approve:
        description: "Skip confirmation prompt (for apply)"
        type: boolean
        default: true

  workflow_call:
    inputs:
      indexes-dir:
        description: "Path to indexes directory"
        type: string
        default: "./indexes"
      srb-version:
        description: "srb version to download (e.g. v0.1.0)"
        type: string
        default: "latest"
      srb-repo:
        description: "GitHub repo that hosts srb releases (owner/repo)"
        type: string
        required: true
      sequin-url:
        description: "Sequin API URL"
        type: string
        required: true
      sequin-context:
        description: "Sequin CLI context"
        type: string
      opensearch-url:
        description: "OpenSearch URL"
        type: string
        required: true
      opensearch-user:
        description: "OpenSearch user"
        type: string
      apply:
        description: "Run apply instead of plan"
        type: boolean
        default: false
      auto-approve:
        description: "Skip confirmation prompt (for apply)"
        type: boolean
        default: true
    secrets:
      sequin-token:
        required: true
      opensearch-password:
        required: false

jobs:
  plan:
    runs-on: ubuntu-latest
    env:
      SRB_SEQUIN_URL: ${{ inputs.sequin-url }}
      SRB_SEQUIN_CONTEXT: ${{ inputs.sequin-context }}
      SRB_SEQUIN_TOKEN: ${{ secrets.sequin-token }}
      SRB_OPENSEARCH_URL: ${{ inputs.opensearch-url }}
      SRB_OPENSEARCH_USER: ${{ inputs.opensearch-user }}
      SRB_OPENSEARCH_PASSWORD: ${{ secrets.opensearch-password }}
      SRB_COMPILED: ./compiled.json
    steps:
      - uses: actions/checkout@v4

      - name: Install Sequin CLI
        run: curl -sf https://raw.githubusercontent.com/sequinstream/sequin/main/cli/installer.sh | sh

      - name: Download srb
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          ARCH=$(uname -m)
          case "$ARCH" in
            x86_64)  ARTIFACT="srb-linux-amd64" ;;
            aarch64) ARTIFACT="srb-linux-arm64" ;;
            *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
          esac

          VERSION="${{ inputs.srb-version }}"
          if [ "$VERSION" = "latest" ]; then
            gh release download --repo "${{ inputs.srb-repo }}" --pattern "$ARTIFACT" --dir /usr/local/bin
          else
            gh release download "$VERSION" --repo "${{ inputs.srb-repo }}" --pattern "$ARTIFACT" --dir /usr/local/bin
          fi
          chmod +x /usr/local/bin/$ARTIFACT
          mv /usr/local/bin/$ARTIFACT /usr/local/bin/srb

      - name: Compile
        run: srb offline compile --indexes ${{ inputs.indexes-dir }} --out compiled.json

      - name: Plan or Apply
        run: |
          if [ "${{ inputs.apply }}" = "true" ]; then
            ARGS="online apply"
            if [ "${{ inputs.auto-approve }}" = "true" ]; then
              ARGS="$ARGS --auto-approve"
            fi
          else
            ARGS="online plan"
          fi
          srb $ARGS
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/plan.yml'))"`
Expected: No output (valid YAML)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/plan.yml
git commit -m "feat: add plan/apply reusable workflow"
```

### Task 3: Activate reusable workflow

**Files:**
- Create: `.github/workflows/activate.yml`

- [ ] **Step 1: Create the activate workflow**

The shared inputs block for activate/drop/backfill is identical except for the command-specific description on `color`. The full YAML:

```yaml
name: SRB Activate

on:
  workflow_dispatch:
    inputs:
      indexes-dir:
        description: "Path to indexes directory"
        type: string
        default: "./indexes"
      srb-version:
        description: "srb version to download (e.g. v0.1.0)"
        type: string
        default: "latest"
      srb-repo:
        description: "GitHub repo that hosts srb releases (owner/repo)"
        type: string
        required: true
      sequin-url:
        description: "Sequin API URL"
        type: string
        required: true
      sequin-context:
        description: "Sequin CLI context"
        type: string
      opensearch-url:
        description: "OpenSearch URL"
        type: string
        required: true
      opensearch-user:
        description: "OpenSearch user"
        type: string
      pipeline:
        description: "Pipeline name"
        type: string
        required: true
      color:
        description: "Color to activate"
        type: string
        required: true

  workflow_call:
    inputs:
      indexes-dir:
        description: "Path to indexes directory"
        type: string
        default: "./indexes"
      srb-version:
        description: "srb version to download (e.g. v0.1.0)"
        type: string
        default: "latest"
      srb-repo:
        description: "GitHub repo that hosts srb releases (owner/repo)"
        type: string
        required: true
      sequin-url:
        description: "Sequin API URL"
        type: string
        required: true
      sequin-context:
        description: "Sequin CLI context"
        type: string
      opensearch-url:
        description: "OpenSearch URL"
        type: string
        required: true
      opensearch-user:
        description: "OpenSearch user"
        type: string
      pipeline:
        description: "Pipeline name"
        type: string
        required: true
      color:
        description: "Color to activate"
        type: string
        required: true
    secrets:
      sequin-token:
        required: true
      opensearch-password:
        required: false

jobs:
  activate:
    runs-on: ubuntu-latest
    env:
      SRB_SEQUIN_URL: ${{ inputs.sequin-url }}
      SRB_SEQUIN_CONTEXT: ${{ inputs.sequin-context }}
      SRB_SEQUIN_TOKEN: ${{ secrets.sequin-token }}
      SRB_OPENSEARCH_URL: ${{ inputs.opensearch-url }}
      SRB_OPENSEARCH_USER: ${{ inputs.opensearch-user }}
      SRB_OPENSEARCH_PASSWORD: ${{ secrets.opensearch-password }}
      SRB_COMPILED: ./compiled.json
    steps:
      - uses: actions/checkout@v4

      - name: Install Sequin CLI
        run: curl -sf https://raw.githubusercontent.com/sequinstream/sequin/main/cli/installer.sh | sh

      - name: Download srb
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          ARCH=$(uname -m)
          case "$ARCH" in
            x86_64)  ARTIFACT="srb-linux-amd64" ;;
            aarch64) ARTIFACT="srb-linux-arm64" ;;
            *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
          esac

          VERSION="${{ inputs.srb-version }}"
          if [ "$VERSION" = "latest" ]; then
            gh release download --repo "${{ inputs.srb-repo }}" --pattern "$ARTIFACT" --dir /usr/local/bin
          else
            gh release download "$VERSION" --repo "${{ inputs.srb-repo }}" --pattern "$ARTIFACT" --dir /usr/local/bin
          fi
          chmod +x /usr/local/bin/$ARTIFACT
          mv /usr/local/bin/$ARTIFACT /usr/local/bin/srb

      - name: Compile
        run: srb offline compile --indexes ${{ inputs.indexes-dir }} --out compiled.json

      - name: Activate
        run: srb online activate ${{ inputs.pipeline }} ${{ inputs.color }}
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/activate.yml'))"`
Expected: No output (valid YAML)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/activate.yml
git commit -m "feat: add activate reusable workflow"
```

### Task 4: Drop reusable workflow

**Files:**
- Create: `.github/workflows/drop.yml`

- [ ] **Step 1: Create the drop workflow**

```yaml
name: SRB Drop

on:
  workflow_dispatch:
    inputs:
      indexes-dir:
        description: "Path to indexes directory"
        type: string
        default: "./indexes"
      srb-version:
        description: "srb version to download (e.g. v0.1.0)"
        type: string
        default: "latest"
      srb-repo:
        description: "GitHub repo that hosts srb releases (owner/repo)"
        type: string
        required: true
      sequin-url:
        description: "Sequin API URL"
        type: string
        required: true
      sequin-context:
        description: "Sequin CLI context"
        type: string
      opensearch-url:
        description: "OpenSearch URL"
        type: string
        required: true
      opensearch-user:
        description: "OpenSearch user"
        type: string
      pipeline:
        description: "Pipeline name"
        type: string
        required: true
      color:
        description: "Color to drop"
        type: string
        required: true

  workflow_call:
    inputs:
      indexes-dir:
        description: "Path to indexes directory"
        type: string
        default: "./indexes"
      srb-version:
        description: "srb version to download (e.g. v0.1.0)"
        type: string
        default: "latest"
      srb-repo:
        description: "GitHub repo that hosts srb releases (owner/repo)"
        type: string
        required: true
      sequin-url:
        description: "Sequin API URL"
        type: string
        required: true
      sequin-context:
        description: "Sequin CLI context"
        type: string
      opensearch-url:
        description: "OpenSearch URL"
        type: string
        required: true
      opensearch-user:
        description: "OpenSearch user"
        type: string
      pipeline:
        description: "Pipeline name"
        type: string
        required: true
      color:
        description: "Color to drop"
        type: string
        required: true
    secrets:
      sequin-token:
        required: true
      opensearch-password:
        required: false

jobs:
  drop:
    runs-on: ubuntu-latest
    env:
      SRB_SEQUIN_URL: ${{ inputs.sequin-url }}
      SRB_SEQUIN_CONTEXT: ${{ inputs.sequin-context }}
      SRB_SEQUIN_TOKEN: ${{ secrets.sequin-token }}
      SRB_OPENSEARCH_URL: ${{ inputs.opensearch-url }}
      SRB_OPENSEARCH_USER: ${{ inputs.opensearch-user }}
      SRB_OPENSEARCH_PASSWORD: ${{ secrets.opensearch-password }}
      SRB_COMPILED: ./compiled.json
    steps:
      - uses: actions/checkout@v4

      - name: Install Sequin CLI
        run: curl -sf https://raw.githubusercontent.com/sequinstream/sequin/main/cli/installer.sh | sh

      - name: Download srb
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          ARCH=$(uname -m)
          case "$ARCH" in
            x86_64)  ARTIFACT="srb-linux-amd64" ;;
            aarch64) ARTIFACT="srb-linux-arm64" ;;
            *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
          esac

          VERSION="${{ inputs.srb-version }}"
          if [ "$VERSION" = "latest" ]; then
            gh release download --repo "${{ inputs.srb-repo }}" --pattern "$ARTIFACT" --dir /usr/local/bin
          else
            gh release download "$VERSION" --repo "${{ inputs.srb-repo }}" --pattern "$ARTIFACT" --dir /usr/local/bin
          fi
          chmod +x /usr/local/bin/$ARTIFACT
          mv /usr/local/bin/$ARTIFACT /usr/local/bin/srb

      - name: Compile
        run: srb offline compile --indexes ${{ inputs.indexes-dir }} --out compiled.json

      - name: Drop
        run: srb online drop ${{ inputs.pipeline }} ${{ inputs.color }}
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/drop.yml'))"`
Expected: No output (valid YAML)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/drop.yml
git commit -m "feat: add drop reusable workflow"
```

### Task 5: Backfill reusable workflow

**Files:**
- Create: `.github/workflows/backfill.yml`

- [ ] **Step 1: Create the backfill workflow**

```yaml
name: SRB Backfill

on:
  workflow_dispatch:
    inputs:
      indexes-dir:
        description: "Path to indexes directory"
        type: string
        default: "./indexes"
      srb-version:
        description: "srb version to download (e.g. v0.1.0)"
        type: string
        default: "latest"
      srb-repo:
        description: "GitHub repo that hosts srb releases (owner/repo)"
        type: string
        required: true
      sequin-url:
        description: "Sequin API URL"
        type: string
        required: true
      sequin-context:
        description: "Sequin CLI context"
        type: string
      opensearch-url:
        description: "OpenSearch URL"
        type: string
        required: true
      opensearch-user:
        description: "OpenSearch user"
        type: string
      pipeline:
        description: "Pipeline name"
        type: string
        required: true
      color:
        description: "Color to backfill"
        type: string
        required: true

  workflow_call:
    inputs:
      indexes-dir:
        description: "Path to indexes directory"
        type: string
        default: "./indexes"
      srb-version:
        description: "srb version to download (e.g. v0.1.0)"
        type: string
        default: "latest"
      srb-repo:
        description: "GitHub repo that hosts srb releases (owner/repo)"
        type: string
        required: true
      sequin-url:
        description: "Sequin API URL"
        type: string
        required: true
      sequin-context:
        description: "Sequin CLI context"
        type: string
      opensearch-url:
        description: "OpenSearch URL"
        type: string
        required: true
      opensearch-user:
        description: "OpenSearch user"
        type: string
      pipeline:
        description: "Pipeline name"
        type: string
        required: true
      color:
        description: "Color to backfill"
        type: string
        required: true
    secrets:
      sequin-token:
        required: true
      opensearch-password:
        required: false

jobs:
  backfill:
    runs-on: ubuntu-latest
    env:
      SRB_SEQUIN_URL: ${{ inputs.sequin-url }}
      SRB_SEQUIN_CONTEXT: ${{ inputs.sequin-context }}
      SRB_SEQUIN_TOKEN: ${{ secrets.sequin-token }}
      SRB_OPENSEARCH_URL: ${{ inputs.opensearch-url }}
      SRB_OPENSEARCH_USER: ${{ inputs.opensearch-user }}
      SRB_OPENSEARCH_PASSWORD: ${{ secrets.opensearch-password }}
      SRB_COMPILED: ./compiled.json
    steps:
      - uses: actions/checkout@v4

      - name: Install Sequin CLI
        run: curl -sf https://raw.githubusercontent.com/sequinstream/sequin/main/cli/installer.sh | sh

      - name: Download srb
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          ARCH=$(uname -m)
          case "$ARCH" in
            x86_64)  ARTIFACT="srb-linux-amd64" ;;
            aarch64) ARTIFACT="srb-linux-arm64" ;;
            *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
          esac

          VERSION="${{ inputs.srb-version }}"
          if [ "$VERSION" = "latest" ]; then
            gh release download --repo "${{ inputs.srb-repo }}" --pattern "$ARTIFACT" --dir /usr/local/bin
          else
            gh release download "$VERSION" --repo "${{ inputs.srb-repo }}" --pattern "$ARTIFACT" --dir /usr/local/bin
          fi
          chmod +x /usr/local/bin/$ARTIFACT
          mv /usr/local/bin/$ARTIFACT /usr/local/bin/srb

      - name: Compile
        run: srb offline compile --indexes ${{ inputs.indexes-dir }} --out compiled.json

      - name: Backfill
        run: srb online backfill ${{ inputs.pipeline }} ${{ inputs.color }}
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/backfill.yml'))"`
Expected: No output (valid YAML)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/backfill.yml
git commit -m "feat: add backfill reusable workflow"
```
