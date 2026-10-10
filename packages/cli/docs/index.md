# vat - Vibe Agent Toolkit CLI

> Agent-friendly toolkit for building, testing, and deploying portable AI agents

## Usage

```bash
vat [options] <command>
```

## Commands

### `resources validate`

Markdown resource scanning, link validation, and frontmatter validation (run before commit)

**What it does:**

1. Scans markdown files for links and anchors
2. Validates internal file links (relative paths)
3. Validates anchor links within files (#heading)
4. Validates cross-file anchor links (file.md#heading)
5. **Validates frontmatter against JSON Schemas** (per-collection)
6. Publishes every finding in the shared report envelope on stdout

**Note:** External URLs are not validated (by design — avoids flaky network checks). Only internal file links and anchors are checked.

**Per-collection frontmatter validation:**

Define collections in `vibe-agent-toolkit.config.yaml` to validate frontmatter fields, types, and patterns using JSON Schemas. Collections support strict mode (no extra fields) or permissive mode (extra fields allowed).

See [Collection Validation Guide](../../../docs/guides/collection-validation.md) for full documentation, examples, and schema patterns.

**When to use:** Before committing changes that touch markdown files

**Exit codes:**

- `0` - All links and frontmatter valid
- `1` - An error-severity finding (a broken link, a schema violation), or nothing validated
- `2` - System error (invalid config, directory not found)

**Creates/modifies:** None (read-only validation)

**Examples:**

```bash
vat resources validate docs/              # Validate docs directory
vat resources validate                    # Use config patterns
vat resources validate --debug            # Show detailed progress
```

---

### `resources scan`

Discover markdown resources in directory and report statistics

**What it does:**

1. Recursively finds markdown files
2. Counts links and anchors
3. Publishes the shared report envelope as YAML to stdout (`--format json` for JSON)

**When to use:** Understanding markdown structure before processing

**Exit codes:**

- `0` - Scanned at least one file
- `1` - Scanned nothing (`RESOURCE_CHECK_BROKEN`)
- `2` - The scan could not run (path names no directory, unreadable, bad config)

**Creates/modifies:** None (read-only scan)

**Output format:** YAML to stdout

```yaml
status: ok
examined: 42
findings: []
summary: { errors: 0, warnings: 0, info: 0 }
gate: { strict: false }
durationMs: 234
data: { root: /abs/path/to/project, lane: projection, extentSource: git, collections: {} }
```

**Examples:**

```bash
vat resources scan .                      # Scan current directory
vat resources scan docs/                  # Scan specific directory
```

---

### `doctor`

Diagnose vat setup and environment health

**What it does:**

- Checks Node.js version (>=22.16.0 required)
- Checks Git installation and repository
- Validates configuration file exists and is valid
- Checks vat version and available updates
- Verifies CLI build status (in VAT source tree)

**When to use:** Before starting development, after updates, or debugging issues

**Exit codes:**

- `0` - No check failed (a check that could not be determined is a `DOCTOR_CHECK_WARNED` warning, not fatal)
- `1` - One or more checks failed (`DOCTOR_CHECK_FAILED`)
- `2` - Doctor itself could not run (an internal failure; no verdict was produced)

**Output:** the report envelope on stdout (`--format yaml|json|text`, default yaml);
`data.checks` lists every check. The human block goes to stderr, or is the stdout
rendering under `--format text`.

**Creates/modifies:** None (read-only diagnostics)

**Examples:**

```bash
vat doctor                                # Run diagnostic checks
vat doctor --verbose                      # Show all checks (including passing)
```

**More details:** `vat doctor --help` or see `packages/cli/docs/doctor.md`

---

### `inventory`

Extract the structural inventory of a Claude plugin, marketplace, skill or install root

**What it does:** enumerates what the subject contains — declared and discovered components,
resolved references, unexpected manifests, and every manifest that did not parse. It runs no
detectors; `vat audit` judges what it finds.

**Exit codes:**

- `0` - The subject was inventoried (`ok`), or a path inside it the OS would not read was skipped
  (`findings`: one `SCAN_PATH_UNREADABLE` warning each — the inventory is then a floor)
- `2` - Nothing could be inventoried: no path, a path that does not exist or is neither a directory
  nor a SKILL.md, an unknown `--format` (`USAGE_INVALID`); a path the OS will not read
  (`INPUT_UNREADABLE`); `--system` (`NOT_IMPLEMENTED`); the projection store's backend not
  installed (`BACKEND_UNAVAILABLE`)

**Output:** the report envelope on stdout (`--format yaml|json`, default yaml). `data.inventory` is
the inventory (`kind`, `vendor`, `path`, per-kind lists, `parseErrors[]`); with `--shallow` it
carries `projection: shallow` and every list it did not walk is `null`, never `[]`. `examined`
counts the subject and each marketplace, plugin and skill inventory nested under it.

**Creates/modifies:** None (read-only)

**Examples:**

```bash
vat inventory my-plugin/                  # Inventory a plugin
vat inventory my-plugin/ --shallow --format json
vat inventory --user                      # The user-level Claude install
```

---

### `agent build`

Build agent for deployment to target runtime

**What it does:**

1. Resolves agent dependencies
2. Bundles agent code for target runtime
3. Generates runtime-specific manifest
4. Creates deployment artifacts

**When to use:** Preparing agent for production deployment

**Exit codes:**

- `0` - Build succeeded
- `1` - Build failed (see stderr for details)
- `2` - Configuration error

**Creates/modifies:**

- `dist/vat-bundles/{target}/` - Bundled agent artifacts
- Runtime-specific manifest files

**Examples:**

```bash
vat agent build ./my-agent                # Build for default target
vat agent build ./my-agent --target agent-skills
vat agent build ./my-agent --output ./dist
```

---

### `agent run`

Execute agent locally for testing

**What it does:**

1. Loads agent from path
2. Executes agent with provided input
3. Outputs agent results

**When to use:** Testing agent behavior before deployment

**Exit codes:**

- `0` - Execution succeeded
- `2` - Execution failed (the agent could not run, or threw)

**Creates/modifies:** Depends on agent behavior

**Examples:**

```bash
vat agent run ./my-agent --input "test query"
vat agent run ./my-agent --debug
```

---

### `skill test`

Run a packaged skill's eval suite in a headless, context-isolated Claude session

**What it does:**

1. Builds and stages the skill (plus any `--with` companion skills)
2. Runs each eval with a blind **executor** — the skill under test
3. Grades the captured transcript with a separate **grader** model
4. Writes `grading.json`, `friction.json`, and `tool-eval.json` to `results/`

**When to use:** Verifying a skill actually works before publishing it

**Exit codes:**

- `0` - Run completed, all expectations passed
- `1` - Run completed and at least one eval failed (a `SKILL_TEST_EVAL_FAILED` finding per failed eval)
- `2` - The harness could not run; `error.code` in the published report says which refusal, and a `Reason: internal | preflight | bootstrap` line on stderr restates it

**Output:** YAML report on stdout (schema `packages/cli/schemas/skill-test-run.json`); see [skill-test.md](./skill-test.md#the-report)

**Creates/modifies:** A harness directory (removed unless `--keep`)

**Note:** This command executes skill code. It is context-isolated, not an OS
sandbox — `--i-understand-this-runs-skill-code` is required.

**Examples:**

```bash
vat skill test run my-skill --i-understand-this-runs-skill-code
vat skill test run my-skill --keep --model claude-opus-5
vat skill test configure my-skill --auth subscription
```

**More details:** `packages/cli/docs/skill-test.md` — full knob table for the
per-skill `skills.config.<skill>.test` block and the global `test:` node

---

### `claude plugin build`

Assemble each Claude plugin bundle declared under `claude.marketplaces` into
`dist/.claude/plugins/marketplaces/<marketplace>/`

**What it does:**

1. Packages each plugin-local skill (`plugins/<name>/skills/**`) with the same
   packager as pool skills, and copies in the pool skills its `skills:` selector names
2. Tree-copies the rest of `plugins/<name>/` (commands, hooks, agents, `.mcp.json`),
   applies `files:` mappings, and merges `.claude-plugin/plugin.json`
3. Writes `.claude-plugin/marketplace.json`; a plugin with `externalSource` is
   listed there verbatim, never built

**`plugin.json` author:** merged per subfield. The config owns `name` and
`email` (from the marketplace `owner`; an omitted `owner.email` publishes no
email even when plugin.json has one); every other subfield of an object
`author` in the plugin's own plugin.json (`url`, ...) passes through. A
plugin.json `name`/`email` that disagrees is overridden with a stderr warning,
not an error. A non-object `author` (npm's `"Name <email>"` string form, say)
has no subfields to merge: it is replaced by the config's object, with a
warning. marketplace.json's entry for the plugin carries the same merged object.

**Output:** a report on stdout — `status`, `summary`, `examined`
(marketplaces built), `findings` (each with `location`), and `data`
(`marketplacesBuilt`, `pluginsBuilt`, `pluginsReferenced`, `skillsPackaged`,
`marketplaces[]` of `{ name, status, reason?, plugins[] { name, outputPath,
skills }, externalPlugins[] }`). Paths are relative to the directory holding
`vibe-agent-toolkit.config.yaml`.

**Exit codes:**

- `0` - Built; any findings are warnings or info
- `1` - A plugin-local skill failed the post-build gate (the build stops there:
  that plugin is not assembled, nothing after it is built, and its marketplace's
  `reason` names it), or no marketplace is configured
- `2` - The build could not run: an undeclared `--marketplace` (`USAGE_INVALID`),
  a missing config or an invalid plugin declaration (`CONFIG_INVALID`), an input
  nothing built or that is not what it should be, or a file the build copies that the
  OS will not read — `LICENSE`, `README.md`, `CHANGELOG.md`, a plugin file, a
  `files[].source`, a built skill in `dist/skills` (`INPUT_UNREADABLE`, naming it), the packager
  refusing a plugin-local skill's content, such as a skill `files:` source that does
  not exist (`RUN_INCOMPLETE`, with a `SKILL_PACKAGING_FAILED` finding at the skill), or
  an output the OS will not let the build write — a full disk, a read-only `dist/`,
  every copy into the marketplace tree included (`RUN_INCOMPLETE`, no finding). Known gap: a
  disk so full that the git snapshot of the project fails before anything is written is still
  `INTERNAL_ERROR` ("git did not answer …")

**Examples:**

```bash
vat skills build && vat claude plugin build
```

---

### `claude marketplace publish`

Push a built marketplace to a git branch, with its CHANGELOG, README and LICENSE

**Output:** a report on stdout; `examined` counts the marketplaces with a
`publish:` block, and `data.published[]` is `{ marketplace, version, branch,
files, dryRun }` (`version` is `null` for a multi-plugin marketplace). A refusal
after one marketplace was published still lists it.

**Exit codes:**

- `0` - Published (or `--dry-run` completed)
- `1` - No marketplace declares `publish:`
- `2` - Publish could not run: `USAGE_INVALID`, `CONFIG_INVALID`,
  `INPUT_UNREADABLE` (no build output, or build output with no readable
  `marketplace.json` — run `vat build`; no release notes), `EXTERNAL_API_FAILED`
  (push rejected), `RUN_INCOMPLETE` (a git step failed)

**Examples:**

```bash
vat build && vat claude marketplace publish --no-push
```

---

### `claude org`

Anthropic organization administration (Admin API) and workspace skills (Skills API)

**Output:** the one `external` entry in the published-shape registry. A
successful run publishes the API's payload as the API returns it (`has_more`,
`data[]`, snake_case) — VAT adds no status word and no duration. A batch or
delete whose writes did not all land still publishes its payload (what landed,
what did not, and why). A run that threw publishes
`{ error: { code, message } }` instead: `USAGE_INVALID` (missing
`ANTHROPIC_ADMIN_API_KEY` / `ANTHROPIC_API_KEY`, a bad argument, no such
source), `INPUT_UNREADABLE` (a source the OS will not read),
`EXTERNAL_API_FAILED` (the API refused, answered unusably, or never answered),
or `INTERNAL_ERROR` (a VAT defect, stack on stderr).

**Exit codes** — no envelope to derive one from, so the entry's adapter maps
what the write did:

| Outcome | Exit |
|---|---|
| `ok` — every write landed, or the read succeeded | `0` |
| `partial` — some writes landed (`skills install --from-npm`, `skills delete --all`) | `2` |
| `failed` — none landed, the API named another outcome, or the run was refused | `2` |

**Not implemented:** `users update|remove`, `invites create|delete`,
`workspaces create|archive`, `workspaces members add|update|remove` and
`api-keys update` are report verbs (`claude-org-not-implemented`): each
publishes the envelope's error branch — `status: error`,
`error.code: NOT_IMPLEMENTED`, `examined: 0`, `data: null` — at exit `2`.

---

### `rag index`

Create vector embeddings for semantic search over documentation

**What it does:**

1. Scans markdown files in specified path
2. Chunks documents for embedding
3. Generates vector embeddings
4. Stores in vector database for fast retrieval

**When to use:** Setting up semantic search capabilities

**Exit codes:**

- `0` - Indexing succeeded
- `1` - Indexing completed but some resources could not be indexed (the report names them)
- `2` - Indexing could not run (no provider, unreadable config)

**Creates/modifies:**

- Vector database files for semantic search
- Index metadata

**Examples:**

```bash
vat rag index docs/                       # Index documentation
```

---

### `rag search`

Search indexed documentation semantically

**What it does:**

1. Queries vector database by semantic meaning
2. Returns ranked results by similarity
3. Outputs results to stdout

**When to use:** Finding relevant documentation by meaning (not keywords)

**Exit codes:**

- `0` - Search succeeded
- `2` - Search could not run (no index, query error)

**Creates/modifies:** None (read-only query)

**Examples:**

```bash
vat rag search "how to validate markdown links"
vat rag search "agent deployment" --limit 5
```

---

## Global Options

- `--version` - Show version number (with `-dev` suffix when running from development repo)
- `--help` - Show help for any command
- `--help --verbose` - Show comprehensive help (this output)
- `--cwd <dir>` - Change working directory before running any command
- `--debug` - Enable debug logging
- `--no-cache` - Disable VAT's on-disk caches for this run, including in spawned child phases
  (equivalent to `VAT_CACHE=0`; see [Environment Variables](#vat_cache)). Clear what is already
  stored with `vat cache clear`.

## Environment Variables

### VAT_CACHE
Set to `0` to disable VAT's on-disk caches for the run — the parse cache and the external-URL
validation caches, which share `<tmpdir>/.vat-cache/`:

```bash
VAT_CACHE=0 vat validate
```

The root `--no-cache` flag is the same switch: it sets this variable. The variable is what makes it
work, because `vat validate`, `vat verify` and `vat build` do their parsing in spawned child
processes, and only the environment crosses that boundary — a flag parsed in the parent would never
reach them.

Caching is a pure optimisation: a run with it off produces identical results, only slower. Use
`vat cache clear` to discard what is already stored.

### VAT_DEBUG
Enable detailed wrapper diagnostics showing context detection and resolution:

```bash
VAT_DEBUG=1 vat --version
# Output includes:
#   - Current working directory
#   - Detected project root
#   - Context (dev/local/global)
#   - Binary path being used
#   - Version information
```

### VAT_ROOT_DIR
Override automatic context detection to force dev mode:

```bash
VAT_ROOT_DIR=/path/to/vibe-agent-toolkit vat --version
```

### VAT_TEST_ROOT

Override project root detection for testing:

```bash
VAT_TEST_ROOT=/path/to/test/fixtures vat resources validate
```

**Use case**: Integration tests that need to run vat commands against test fixtures without relying on directory structure (.git or config file).

**Example**:
```typescript
// Test setup
process.env.VAT_TEST_ROOT = '/path/to/test/fixtures';
const root = findProjectRoot(process.cwd()); // Returns /path/to/test/fixtures
```

### VAT_TEST_CONFIG

Override config file path for testing:

```bash
VAT_TEST_CONFIG=/path/to/test/fixtures/config.yaml vat resources validate
```

**Use case**: Integration tests that need to test with specific config files without modifying project structure.

**Example**:
```typescript
// Test setup
process.env.VAT_TEST_CONFIG = '/path/to/test/fixtures/config.yaml';
const config = loadConfig('/any/path'); // Uses override path
```

**Testing pattern**: Combine VAT_TEST_ROOT and VAT_TEST_CONFIG for complete control:

```bash
VAT_TEST_ROOT=/path/to/fixtures \
VAT_TEST_CONFIG=/path/to/fixtures/config.yaml \
vat resources validate
```

## Context Detection

The `vat` wrapper automatically detects your execution context:

**Dev mode** - Running from within vibe-agent-toolkit repository:
- Shows version with `-dev` suffix: `0.1.0-rc.9-dev (/path/to/repo)`
- Uses development build directly (no packaging)
- Works from any subdirectory within the repo

`vat --version` always prints a second line naming the binary that produced it:

```
0.1.0-rc.9-dev (/path/to/repo)
  binary: /path/to/repo/packages/cli/dist/bin.js
```

The context label on the first line is derived from your current directory; the `binary:` line is
derived from the file Node actually loaded. Run a checkout's build by absolute path from somewhere
else and the label reads `global` — the `binary:` line is then the only thing that tells you which
build you ran.

**Local install** - Project has vibe-agent-toolkit in node_modules:
- Uses locally installed version
- Shown in version output: `0.1.0-rc.9 (local: /path/to/project)`

**Global install** - Fallback when no local install found:
- Uses globally installed version
- Shows clean version: `0.1.0-rc.9`

When running global `vat` from within the toolkit repository, it automatically
switches to dev mode and shows the `-dev` suffix.

## Requirements

Every VAT command declares a `projectRoot` policy and a config policy. The
short version:

- **`projectRoot` = the VAT authoring boundary.** Discovered as: nearest
  `vibe-agent-toolkit.config.yaml` → else nearest `.git/` → else `null`.
- **Per-command policy varies.** Some commands require it (`vat skills build`,
  `vat agent build`, `vat build`, `vat verify`). Some tolerate its absence
  (`vat skills validate --user`, `vat agent list`, `vat rag *` with `--db`).
  Some have a **loud-cwd fallback** that warns to stderr and continues
  (`vat resources scan`, `vat resources validate`).
- **`vat audit` is special:** there is no single `projectRoot`; each scanned
  skill walks up to its own governing context.

Every command's `--help` output includes a `Requirements:` section declaring
its policy. The full matrix and rationale live in
[Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md).

## Configuration

Place `vibe-agent-toolkit.config.yaml` at project root:

```yaml
resources:
  include:
    - "docs/**/*.md"
    - "README.md"
  exclude:
    - "node_modules/**"
    - "**/archive/**"
```

## Exit Code Summary

One contract, every command:

- `0` - **OK.** The command ran and found nothing at error severity. Warnings and informational findings are in the document, not the exit code (a command that offers `--strict` promotes warnings).
- `1` - **Findings.** The command ran to completion and what it examined failed its gate: an error-severity finding, a failed eval, a broken link, a partial index.
- `2` - **Error.** The command could not do its job: a usage mistake (unknown flag or verb, a retired `--only`), a root path that does not exist or is not something the verb can act on, an unreadable config, a missing dependency, an internal failure (a crash anywhere in a command ends on `2`, never on Node's default `1`). Where a verb has more than one such cause it says which on stderr (`vat skill test run` prints `Reason: …`) — never in a fourth exit code. A path INSIDE a tree that the command cannot read is a finding, not an error: `vat audit` degrades it to `SCAN_PATH_UNREADABLE` and exits `0` or `1` on what it could read.

A CI wrapper reads `$?` the same way for every verb:

```bash
case $? in 0) ;; 1) echo findings ;; *) echo broken; exit 1 ;; esac
```

## Output Formats

**Structured output (YAML)** - Commands like `scan` output YAML to stdout for parsing:
```bash
vat resources scan . | yq '.examined'
```

**Error output (stderr)** - Validation errors use test format:
```
file:line:col: severity: message
```

## Common Workflows

**Before committing documentation:**
```bash
vat resources validate docs/ && git commit -m "Update docs"
```

**Building and testing agent:**
```bash
vat agent build ./my-agent
vat agent run ./my-agent --input "test"
```

**Setting up semantic search:**
```bash
vat rag index docs/
vat rag search "markdown validation"
```

## More Information

- **Documentation:** https://github.com/jdutton/vibe-agent-toolkit
- **Issues:** https://github.com/jdutton/vibe-agent-toolkit/issues

## Example reports

Each block below is a real document from the built CLI, trimmed where noted; `packages/cli/test/integration/tagged-report-examples.integration.test.ts` validates every `vat-report=<verb>` block against that verb's registered schema.

### `ard emit`

A project declaring an ARD publisher but no skill entries. Produced by `vat ard emit --format json`.

```json vat-report=ard emit
{
  "status": "findings",
  "examined": 2,
  "findings": [
    {
      "code": "ARD_SURFACE_SKIPPED",
      "severity": "warning",
      "message": "skipped skill \"(discovered skills)\": skills.config is empty, so no skill was advertised. ARD entries are derived per named skill; add `skills.config.<name>` for each skill you want announced. Discovery globs alone (`skills.include`) do not name them."
    },
    {
      "code": "ARD_SURFACE_SKIPPED",
      "severity": "warning",
      "message": "skipped okf-bundle \"playbooks\": the ARD specification names no media type for surface kind \"okf-bundle\", so VAT derives none. Set `ard.entries.\"okf-bundle:playbooks\".type` to advertise it."
    }
  ],
  "summary": {
    "errors": 0,
    "warnings": 2,
    "info": 0
  },
  "gate": {
    "strict": false
  },
  "data": {
    "outputPath": "/work/project/.well-known/ard.json",
    "entryCount": 0,
    "skippedCount": 2,
    "shadowedCount": 0
  },
  "durationMs": 2414
}
```

### `okf validate`

A bundle with one document missing its frontmatter. Produced by `vat okf validate`.

```yaml vat-report=okf validate
status: findings
examined: 2
findings:
  - code: OKF_FRONTMATTER_MISSING
    severity: error
    message: No YAML frontmatter block. OKF §11.1 requires one on every non-reserved .md file; only index.md and log.md are exempt (§3.1).
    location: knowledge/playbooks/notes.md
summary:
  errors: 1
  warnings: 0
  info: 0
gate:
  strict: false
data:
  bundles:
    - bundle: playbooks
      root: knowledge/playbooks
      conceptDocuments:
        - expenses.md
        - notes.md
      reservedDocuments: []
durationMs: 77
```

### `cache clear`

The cache directory emptied. Produced by `vat cache clear`.

```yaml vat-report=cache clear
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
data:
  cacheDir: /tmp/.vat-cache
  existed: true
  removed:
    - x.y.z
  entriesRemoved: 3
  bytesRemoved: 262998
```

### `corpus scan`

A one-plugin seed. Produced by `vat corpus scan seed.yaml --out corpus`.

```yaml vat-report=corpus scan
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 273
data:
  outDir: /work/corpus
  entries:
    - name: sample
      audit: ok
      review: skipped
      outputPath: 2026-10-04-e61d62b6/sample-audit.yaml
```

### `validate`

`validate`, `build` and `verify` share one shape: each phase folds into `data.phases`. Produced by `vat validate`.

```yaml vat-report=validate
status: ok
examined: 2
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 18127
data:
  phases:
    - name: skills
      status: ok
      examined: 2
      summary:
        errors: 0
        warnings: 0
        info: 0
      data:
        root: /work/project
        skills:
          - name: test-skill-1
            status: ok
            summary:
              errors: 0
              warnings: 0
              info: 0
            allowed: 0
          - name: test-skill-2
            status: ok
            summary:
              errors: 0
              warnings: 0
              info: 0
            allowed: 0
```

### `claude plugin build`

One marketplace with one plugin built. Produced by `vat claude plugin build`.

```yaml vat-report=claude plugin build
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 12847
data:
  marketplacesBuilt: 1
  pluginsBuilt: 1
  pluginsReferenced: 0
  skillsPackaged: 2
  marketplaces:
    - name: mp1
      status: ok
      plugins:
        - name: sample
          outputPath: dist/.claude/plugins/marketplaces/mp1/plugins/sample
          skills:
            - test-skill-1
            - test-skill-2
      externalPlugins: []
```

### `claude plugin install`

A skill directory installed. Produced by `vat claude plugin install dist/skills/test-skill-1 --skills-dir ~/.claude/skills`.

```yaml vat-report=claude plugin install
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 8
data:
  source: local:/work/project/dist/skills/test-skill-1
  sourceType: local
  dryRun: false
  symlink: false
  skills:
    - name: test-skill-1
      installPath: ~/.claude/skills/test-skill-1
      sourcePath: null
```

### `claude plugin list`

Nothing in the plugin registry; one flat skill. Produced by `vat claude plugin list`.

```yaml vat-report=claude plugin list
status: ok
examined: 2
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 1
data:
  target: code
  sources:
    pluginRegistry: ~/.claude/plugins/installed_plugins.json
    legacySkillsDir: ~/.claude/skills
  plugins: []
  legacySkills:
    - name: test-skill-1
      path: ~/.claude/skills/test-skill-1
      type: directory
```

### `claude plugin uninstall`

A key that was not installed: `removed: false`. Produced by `vat claude plugin uninstall sample@mp1`.

```yaml vat-report=claude plugin uninstall
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 1
data:
  dryRun: false
  plugins:
    - key: sample@mp1
      removed: false
```

### `claude marketplace validate`

A built marketplace missing its LICENSE: `findings`, exit `1`. Produced by `vat claude marketplace validate dist/.claude/plugins/marketplaces/mp1`.

```yaml vat-report=claude marketplace validate
status: findings
examined: 1
findings:
  - severity: error
    code: MARKETPLACE_MISSING_LICENSE
    message: Marketplace is missing a LICENSE — required for distribution
    location: LICENSE
    fix: Add a LICENSE to the marketplace root directory
  - severity: warning
    code: MARKETPLACE_MISSING_README
    message: Marketplace is missing a README.md — recommended for documentation
    location: README.md
    fix: Add a README.md to the marketplace root directory
  - severity: warning
    code: MARKETPLACE_MISSING_CHANGELOG
    message: Marketplace is missing a CHANGELOG.md — recommended for tracking changes
    location: CHANGELOG.md
    fix: Add a CHANGELOG.md to the marketplace root directory
  - severity: info
    code: PLUGIN_MISSING_LICENSE
    message: plugin.json is missing the recommended `license` field.
    location: plugins/sample/.claude-plugin/plugin.json
    fix: Add a "license" SPDX identifier (e.g. "MIT") to plugin.json so redistribution terms are explicit.
    reference: "#plugin_missing_license"
summary:
  errors: 1
  warnings: 2
  info: 1
gate:
  strict: false
durationMs: 45
data:
  root: /work/project/dist/.claude/plugins/marketplaces/mp1
  marketplace:
    name: mp1
    pluginEntries: 1
    localPluginSources:
      - name: sample
        source: ./plugins/sample
  plugins:
    - name: sample
      source: ./plugins/sample
      path: plugins/sample
      manifestRead: true
      status: findings
      summary:
        errors: 0
        warnings: 0
        info: 1
  undeclared: []
  refused: []
```

### `claude marketplace publish`

No marketplace declares a `publish:` block, so nothing was examined. Produced by `vat claude marketplace publish --dry-run`.

```yaml vat-report=claude marketplace publish
status: findings
examined: 0
findings:
  - code: RESOURCE_CHECK_BROKEN
    severity: error
    message: "Nothing was examined: 0 marketplaces. No marketplace declares a publish: block — add claude.marketplaces.<name>.publish to vibe-agent-toolkit.config.yaml."
summary:
  errors: 1
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 151
data:
  published: []
```

One declared marketplace, previewed. Produced by `vat claude marketplace publish --dry-run` in a project whose `my-mp` marketplace declares a `publish:` block and has been built.

```yaml vat-report=claude marketplace publish
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 199
data:
  published:
    - marketplace: my-mp
      version: 1.0.0
      branch: claude-marketplace
      files:
        - .claude-plugin/marketplace.json
        - plugins/
        - CHANGELOG.md
        - README.md
        - LICENSE
      dryRun: true
```

### `claude org users remove`

The not-implemented stubs publish only this `error` branch. Produced by `vat claude org users remove u1`.

```yaml vat-report=claude org users remove
status: error
examined: 0
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
error:
  code: NOT_IMPLEMENTED
  message: This command is not implemented. Read operations (list/get) are implemented; mutating operations are not. Use the Anthropic Console or call the Admin API directly.
data: null
```
