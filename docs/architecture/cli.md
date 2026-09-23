# CLI Architecture

**Command:** `vat` (Vibe Agent Toolkit)
**Status:** In Development

## Overview

The `vat` CLI provides command-line access to vibe-agent-toolkit capabilities for both humans and AI agents. The architecture is based on proven patterns from vibe-validate, emphasizing:

- **Human and Agent Friendly**: YAML output readable by both
- **Scoped Commands**: Namespaced by package (e.g., `vat resources`, `vat rag`)
- **No Backward Compatibility Initially**: Free to evolve until explicitly stated
- **Schema-Based**: Zod schemas with JSON Schema exports
- **Cross-Platform**: Works on Windows, macOS, Linux

## Package Structure

### Umbrella Package: `vibe-agent-toolkit`

User-facing package that provides the `vat` command.

**Installation:**
```bash
npm install -g vibe-agent-toolkit
```

**Responsibility:** Lightweight delegation to `@vibe-agent-toolkit/cli`

### Implementation Package: `@vibe-agent-toolkit/cli`

Contains all CLI logic and command implementations.

**Directory Structure:**
```
packages/cli/
├── src/
│   ├── bin.ts                   # Main entry (Commander setup)
│   ├── bin/
│   │   └── vat.ts              # Smart wrapper (context detection)
│   ├── commands/
│   │   ├── resources/          # Resources command group
│   │   ├── rag/                # Future: RAG commands
│   │   ├── skills/             # Future: Skills commands
│   │   └── agents/             # Future: Agent commands
│   ├── utils/
│   │   ├── logger.ts           # stderr logging
│   │   ├── project-root.ts     # Root detection
│   │   ├── config-loader.ts    # Config merging
│   │   └── output.ts           # YAML/stream management
│   └── index.ts                # Public API exports
└── dist/                        # Compiled output
```

**Dependencies:**
- `@vibe-agent-toolkit/resources` - for resource commands
- `@vibe-agent-toolkit/utils` - shared utilities
- Future: `rag`, `agent-skills`, etc.

**Technology:**
- Commander.js for command structure
- TypeScript compiled to ESM
- Zod schemas for validation
- Cross-platform Node.js APIs

## Why the CLI Layer Stays Dumb

The CLI package sits at the top of the dependency chain — no other package can depend on it.
Putting logic in the CLI that other packages need creates an impossible dependency situation:

- Other packages can't depend on CLI (circular dependency)
- Logic gets duplicated across packages (DRY violation)
- Changes require coordinating multiple packages

The rule itself (what CLI should/shouldn't contain) lives in
[`packages/cli/CLAUDE.md`](../../packages/cli/CLAUDE.md#the-cli-must-remain-dumb) — this section
is the rationale and worked example behind it.

### The Right Place for Logic

| Logic Type | Wrong Place | Right Place | Why |
|------------|-------------|-------------|-----|
| Find agent's package root | CLI | agent-skills or utils | Other runtimes (langchain, etc.) will need this |
| Determine default output path | CLI | agent-skills | Each runtime knows where its bundles should go |
| Validate agent manifest | CLI | agent-config | Validation used by all consumers |
| Parse YAML | CLI | utils or agent-config | Common across many packages |
| Format user messages | CLI | ✅ CLI is fine | This is CLI-specific UX |

### Example: Agent Build Command

**Before (WRONG)** - Logic in CLI:
```typescript
// packages/cli/src/commands/agent/build.ts
function findAgentPackageRoot(agentPath: string): string {
  // 50 lines of path-walking logic...
  // ❌ This belongs elsewhere!
}

function determineOutputPath(target: string, agentPath: string): string {
  const packageRoot = findAgentPackageRoot(agentPath);
  return path.join(packageRoot, 'dist', 'vat-bundles', target);
}
```

**After (CORRECT)** - Logic in runtime package:
```typescript
// packages/cli/src/commands/agent/build.ts
const buildOptions = options.output
  ? { agentPath, target, outputPath: options.output }
  : { agentPath, target };
// ✅ CLI just passes options, runtime figures out the rest
result = await buildAgentSkill(buildOptions);
```

```typescript
// packages/agent-skills/src/builder.ts
function getDefaultOutputPath(manifestPath: string, target: string): string {
  const agentPackageRoot = findAgentPackageRoot(manifestPath);
  return path.join(agentPackageRoot, 'dist', 'vat-bundles', target);
}
// ✅ Logic lives where it can be reused by other runtimes
```

### Self-Hosting Consideration

Remember: **Other agent repos won't have packages/cli/**. If an agent package needs to build itself, it can depend on `@vibe-agent-toolkit/agent-skills` directly. The CLI is just one convenient way to invoke the build - not the only way.

## Context Detection

### Hybrid Approach

Provides explicit control when needed, automatic detection otherwise.

**Priority order:**
1. **Explicit override:** `VAT_ROOT_DIR` environment variable
2. **Dev mode:** Detect if running inside vibe-agent-toolkit repo
3. **Local install:** Walk up from project root to find `node_modules/@vibe-agent-toolkit/cli`
4. **Global install:** Use globally installed version

### Implementation

Context detection in `packages/cli/src/bin/vat.ts` spawns the actual CLI with `VAT_CONTEXT` environment variable set to `dev`, `local`, or `global`.

**Version Display:**

```bash
# Dev mode
vat --version → 0.1.0-dev (/Users/jeff/Workspaces/vibe-agent-toolkit)
                 binary: /Users/jeff/Workspaces/vibe-agent-toolkit/packages/cli/dist/bin.js

# Local install
vat --version → 0.1.0 (local: /path/to/project)
                 binary: /path/to/project/node_modules/@vibe-agent-toolkit/cli/dist/bin.js

# Global install
vat --version → 0.1.0
                 binary: /usr/local/lib/node_modules/vibe-agent-toolkit/…/dist/bin.js
```

The `binary:` line is unconditional and derived from the entry module itself, not from the cwd.
The context label above it *is* cwd-derived, so the same build invoked by absolute path from
another repo reports `global` and would otherwise print a version indistinguishable from the
released one — which is precisely the situation every adopter delta test runs in.

## Command Structure

### Namespace Pattern

Commands are scoped by package name for scalability:

```bash
vat resources scan [path]       # Resource discovery
vat resources validate [path]   # Resource validation
vat rag ...                     # Future: RAG commands
vat skills ...                  # Future: Skill commands
vat agents ...                  # Future: Agent commands
vat validate                    # Run all configured source validators (resources + skills)
```

### Command Groups

Each package gets its own command group:
- `resources` - Markdown/HTML parsing and validation
- `rag` - Document chunking, embedding, retrieval
- `skills` - Claude skill packaging and testing
- `agents` - Agent validation and management

### Project Root Detection

Walk up directory tree until finding:
- `.git` directory, OR
- `vibe-agent-toolkit.config.yaml`

Either indicates project root.

### Command File Structure

```typescript
// commands/mycommand.ts
import { ExitCode } from '@vibe-agent-toolkit/schema';

export interface MyCommandOptions {
  debug?: boolean;
  // ... other options
}

export async function myCommand(
  pathArg: string | undefined,
  options: MyCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // 1. Validate inputs
    // 2. Process
    // 3. Output results (YAML to stdout)
    // 4. Exit with appropriate code — a member of `ExitCode`, never a literal
    //    (`local/no-literal-process-exit`)

    process.exit(ExitCode.OK);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MyCommand');
  }
}
```

## Configuration

### Two-Level Hierarchy

#### Project-Level Config

**File:** `vibe-agent-toolkit.config.yaml` (at project root)

**Purpose:** Defaults for entire project (collection of agents)

**Example:**
```yaml
resources:
  include:
    - "docs/**/*.md"
    - "agents/**/README.md"
  exclude:
    - "node_modules/**"
    - "**/test/fixtures/**"
  # Optional per-code severity overrides (error | warning | info | ignore).
  validation:
    severity:
      EXTERNAL_URL_DEAD: ignore
      FRONTMATTER_SCHEMA_ERROR: error
```

#### Agent-Level Config

**File:** TBD (likely `agent.yaml`)

**Purpose:** Override project defaults for specific agent

**Pattern:** Agent config inherits from project config, overriding specific values (DRY)

## Output Strategy

### YAML by Default

All commands output YAML on stdout (readable by humans and agents):

```yaml
---
status: success
filesScanned: 12
durationSecs: 0.234
---
```

Future: `--format json` flag for JSON output

### Dual Output for Errors

Commands that find errors produce both formats:

#### Test Format (stderr)

```
docs/README.md:15:25: error: Link target not found: ./missing.md
docs/guide.md:42:10: error: Broken anchor: #non-existent-section
fragment.component.html:1:1: info: Malformed HTML: missing-doctype
```

**Format:** `file:line:column: severity: message`

Only `error` findings fail the run, so the severity is what tells a reader
which lines they have to act on.

**Purpose:**
- vibe-validate can extract immediately
- Works with existing error extractors
- Standard across test frameworks

#### YAML Structure (stdout)

```yaml
---
# status is the worst ACTIONABLE severity: success | warning | error.
# Info-only findings report `success` — read issueCounts for what was seen.
status: error
errorsFound: 2
issueCounts: { errors: 2, warnings: 0, info: 0 }
issues:
  - file: docs/README.md
    issues:
      - line: 15
        column: 25
        code: LINK_BROKEN_FILE
        severity: error
        message: Link target not found: ./missing.md
  - file: docs/guide.md
    line: 42
    column: 10
    type: broken-anchor
    message: Broken anchor: #non-existent-section
---
```

**Purpose:**
- Structured data for agents
- Rich metadata (error types, context)
- Machine-parseable

### Stream Management

**Critical pattern to prevent YAML corruption:**

```typescript
// 1. Write complete YAML to stdout
process.stdout.write('---\n');
process.stdout.write(yamlOutput);
process.stdout.write('---\n');

// 2. Flush stdout explicitly
await new Promise<void>((resolve) => {
  if (process.stdout.writableNeedDrain) {
    process.stdout.once('drain', resolve);
  } else {
    resolve();
  }
});

// 3. NOW write to stderr
process.stderr.write(errorOutput);
```

**Why:** Prevents corruption when `2>&1` is used in shell commands

### Logging Guidelines

- **stderr only:** Human-facing logs, warnings, debug info
- **stdout only:** YAML/JSON structured output
- **Never mix streams**

## Documentation & Help

### Verbose Help Pattern

Comprehensive markdown output for documentation:

```bash
vat --help --verbose              # All commands, full docs
vat resources --help --verbose    # Resources commands only
```

**Output includes:**
- Command purpose and description
- What it does (step-by-step)
- Options and flags
- Exit codes (`ExitCode`: 0 = nothing at error severity, 1 = findings, 2 = the command could not do its job)
- Files created/modified
- Examples with bash code blocks
- Error guidance

### Help Registry

Dynamic loading pattern to avoid startup overhead:

```typescript
type VerboseHelpLoader = () => Promise<() => void>;

const verboseHelpRegistry: Record<string, VerboseHelpLoader> = {
  'resources': async () => {
    const { showResourcesVerboseHelp } =
      await import('./commands/resources/help.js');
    return showResourcesVerboseHelp;
  },
};
```

Each command group exports its verbose help function.

### Markdown-Based Documentation

**Location:** `packages/cli/docs/*.md`

**Architecture:**
- Markdown files are the single source of truth for verbose help
- Loaded at runtime by `help-loader.ts` utility
- Included in published npm package via `files` array
- No code generation or duplication needed

**Files:**
- `packages/cli/docs/index.md` - Root verbose help (`vat --help --verbose`)
- `packages/cli/docs/resources.md` - Resources verbose help (`vat resources --help --verbose`)

**Benefits:**
- Documentation never drifts from CLI behavior (single source)
- Easy to edit without rebuilding
- Browsable on GitHub and npm
- No build-time documentation generation needed

## Resources Commands

### `vat resources scan [path]`

**Purpose:** Intelligent discovery of markdown resources

**Behavior:**
- Scans directory for markdown files (vat-aware discovery)
- Shows what files would be validated
- Displays stats: file count, link count, etc.
- Helps decide inclusions/exclusions before validation
- Always exits 0 (informational only)
- Defaults to project root if no path provided

**Example output:**
```yaml
---
status: success
root: /abs/path/to/project
filesScanned: 12
linksFound: 47
anchorsFound: 23
files:
  - path: docs/README.md
    links: 5
    anchors: 3
    checksum: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
durationSecs: 0.234
---
```

### `vat resources validate [path]`

**Purpose:** Strict validation with error reporting

**Behavior:**
- Validates discovered resources (link integrity, anchors, structure)
- Exits 0 if valid, non-zero if errors found
- Defaults to project root if no path provided
- Dual output: test format (stderr) + YAML (stdout)
- CI/CD gate

**Success output:**
```yaml
---
status: success
filesScanned: 12
linksChecked: 47
anchorsChecked: 23
duration: 456ms
---
```

**Error output:**

*stderr:*
```
docs/README.md:15:25: error: Link target not found: ./missing.md
```

*stdout:*
```yaml
---
status: error
filesScanned: 12
errorsFound: 1
filesWithErrors: 1
issueCounts: { errors: 1, warnings: 0, info: 0 }
issueSummary: { LINK_BROKEN_FILE: 1 }
issues:
  - file: docs/README.md
    issues:
      - line: 15
        column: 25
        code: LINK_BROKEN_FILE
        severity: error
        message: Link target not found: ./missing.md
---
```

### `vat resources check [path]`

**Purpose:** Run the project's own assertions over its resource projection, as a gate.

A query answers a question once. A question worth asking twice is a rule, and a rule that lives in
someone's shell history is not enforced — it decays into a comment. This verb runs the statements a
project wrote into `resources.checks` plus VAT's own built-in set, turns each violating row into an
ordinary validation finding, and exits non-zero when any of them is an error. That is the whole
difference between `vat resources query` and this, and it is the difference between a tool and a gate.

The invariants below are load-bearing; `packages/cli/src/commands/resources/check.ts` implements
them and points here.

#### 🔑 Four ways to check nothing, all of them refusals

VAT ships no schema version, so a renamed column simply breaks a check's SQL. The tempting handling
— log it and carry on — is the one thing this must never do: a check that stopped running looks
exactly like a check that passed, and the project keeps reporting green over an assertion nobody is
making any more. Four situations collapse to that same shape, and all four are reported at **error**
severity under one non-overridable code, `RESOURCE_CHECK_BROKEN`:

| Situation | Mechanism |
|---|---|
| A statement will not run | reported with the columns the projection actually has, from the `catch` in `runUnits` |
| The corpus enumerated empty | `checksRun` counts RULES, so nothing counted the ROWS; `membersEnumerated` is published and a run over zero members refuses (`emptyCorpusFinding`) |
| `--check <name>` matched nothing | `requireKnownCheck` refuses before the crawl, naming the declared set |
| Not one check executed at all | `noCheckRanFinding`, derived in `buildCheckOutputData` |

The empty-corpus case is the one that shipped: a broad `.gitignore`, a shallow or sparse CI
checkout, or a root that resolved somewhere else ran every declared check over nothing and reported
`status: success` on exit 0 with empty stderr. Population declines ignored members rather than
flagging them, so the tables held no trace of it either.

The fourth case changed meaning once a DEFAULT SET existed. `checksRun` counts the built-in set plus
whatever the project declared, so an absent `checks:` block no longer produces a zero — and it must
not, because a project with no config has to run the defaults and be able to pass. The refusal now
means what it always literally said: **not one check executed, the defaults included**, which is a
defect in VAT or an emptied default list rather than anything an adopter wrote. Deriving it in
`buildCheckOutputData` is what stops a future edit that empties `BUILTIN_CHECKS` from publishing a
clean document.

⚠️ **What is NOT claimed:** that the step can now always fail. No built-in ships at `error` (one at
`info`, one at `warning`), so a project declaring no checks of its own has a `vat resources check`
step that exits 0 whatever it finds. That is a property of the code's SEVERITY — movable with `resources.validation.severity` —
and not of the denominator, and inventing a second refusal for it would refuse the no-config run the
default set exists to serve. The stderr warning says which situation the operator is in; the
document names every rule that ran in `checks[]`, with `builtin: true` on the ones VAT supplied, so
a deleted `checks:` block is visible in the machine channel rather than only in a warning nothing
parses.

#### 🔑 No built-in check may be SQL

Every SQL statement this verb runs is adopter-declared: `checkCommand` reads
`config?.resources?.checks` and nothing else for statements. The one way to end that quietly is to
author a built-in as SQL — a default-on rule written as a statement makes the engine, the projection
and the population mandatory for everyone who inherits it, without anybody deciding that. So
**built-ins are TypeScript predicates over the projection's row model.** SQL stays the two places a
user asked for it: this verb's declared checks, and `vat resources query`.

✅ The first built-in is `claude-rule-glob-inert`, in `@vibe-agent-toolkit/resources`'
`builtin-checks.ts`: a for-loop over `claudeRulePatterns`, which the population already holds in
memory. It ships its SQL twin as `sqlTwin` — DOCUMENTATION an adopter copies into their own
`resources.checks` to narrow or re-severity, printed by `--help`, never executed. That is the point
of materialising these facts as tables: the built-in is the default REPORT, and the same question
stays askable by anyone who wants a different answer.

✅ The second is `claude-rule-frontmatter-invalid` (`CLAUDE_RULE_FRONTMATTER_INVALID`), and it
exists because of the first one's blind spot: a rules file whose YAML frontmatter VAT cannot read
produces no `claude_rule_patterns` rows, so the inert check had nothing to read and passed. It reads
`blobs.frontmatterError` for identities tagged `rules-file` instead — one finding per file. Two
reasons fill that column: YAML that does not parse, and a block that parses to a **sequence or a
scalar**, which has no `paths:` key to read and used to be indistinguishable from a file with no
frontmatter at all.

✅ The third is `claude-rule-link-unchecked` (`CLAUDE_RULE_LINK_UNCHECKED`), and it exists because of
BOTH of their blind spots. VAT realizes no symbolic link's own path, so a `.claude/rules/x.md` that
is a link — or a linked rules directory — has no realization row, no blob and no pattern row, and
both checks above pass on it — while Claude Code loads it when the link's target stays inside the
root, skips it when the target resolves outside, and loads nothing when the link resolves to nothing
([evidence](../external/claude-code-rules-paths-behaviour.md)). It reads the `realization_conditions`
rows the extents record under any declined-link code (`EXTENT_SYMLINK_NOT_REALIZED`,
`EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT` or `EXTENT_SYMLINK_TARGET_UNRESOLVED`, all `info`, read together through `DECLINED_SYMLINK_CODES`)
and reports the ones at or under a rules directory, or at a
`.claude` directory itself — which carries a rules directory with it while its own path stops short
of the `rules` segment — which is why `BuiltinCheckInput` carries that table, REQUIRED like every
other member.

**A built-in's findings carry an ORDINARY registry code.** A built-in is not a custom check: its
findings carry a `CODE_REGISTRY` code with the registry's own default severity, so
`resources.validation.severity.<CODE>` moves it exactly like every other code VAT emits, through the
identical `resolveIssueSeverity` call. The `CUSTOM:<name>` space that `sql-checks.ts` mints is for
ADOPTER-declared statements, whose severity is declared beside them because the registry holds no
entry for a name a user invented; reusing it for a built-in would put a shipped rule in a key space
the schema validates by shape instead of by identity, and a misspelled override would silently reach
nothing.

⚠️ The engine today is `node:sqlite`, built into Node, so what is at stake is not an install — it is
the POPULATION. On an ~11,700-member adopter tree, building the projection is **>99.9%** of a check
run (16.5 s cold, ~1.3 s from the store) against **0.0008–0.004 s** for the statements themselves.
That is exactly the cost "What this does not do" below refuses to put on every adopter's pre-commit
path, and a default-on SQL check would put it there without the decision. The INSTALL cost is
deferred rather than gone: the open question about a columnar engine is a 108 MB platform binding on
a published toolkit, and this invariant is what keeps that question answerable either way.

#### 🔑 The default check set belongs to the pipeline, not to the config file

A directory with no `vibe-agent-toolkit.config.yaml` must run exactly the same default-on checks as
one with a config; config only ADDS to that set or OVERRIDES a severity in it. *"'Default-on error'
is meaningless as a category if being default-on requires a config file to say so."*

That is a constraint on WHERE the defaults live in code, not only on what they are. They cannot be
defaulted into the parsed config object, because an absent config is `undefined` and every default
would vanish with it — for the project that never wrote one, which is the population the category
exists for. The rest of VAT already behaves this way: `vat audit` completes its entire scan first
and reads config only to apply severity overrides, warning and CONTINUING when the file cannot be
read; `loadResourcesWithConfig` hands `vat resources validate` a registry whose built-in validators
run whether `loadConfig` returned a config or nothing.

✅ **Honoured by construction.** `BUILTIN_CHECKS` is a module constant in
`@vibe-agent-toolkit/resources`; `runOutcome` binds it to the projection and hands it to
`runProjectChecks` as `builtins`, a REQUIRED argument beside `checks` rather than a default folded
into either. Nothing on that path reads `config`.

#### Keeping a TypeScript check and its SQL twin: two good reasons, one trap

The proposal was "write the predicate twice, in TypeScript and in SQL, and run whichever is faster".
Two thirds of it are worth having.

✅ **As documentation.** An SQL twin is executable documentation of the row model, and strictly
better than prose about it: prose can describe a column that no longer exists and never say so,
while a statement stops compiling — which this verb reports as `RESOURCE_CHECK_BROKEN` rather than
as a skip.

✅ **As a differential oracle.** Run both over the frozen corpus and assert IDENTICAL findings. That
is the only thing which makes a dual implementation better than a single one rather than worse: two
implementations with no mandatory differential test are simply two places for one rule to be wrong.
Apply it selectively, to genuinely relational checks — done by default, every new rule costs three
artifacts instead of one.

⛔ **As a runtime optimizer — rejected, on two INDEPENDENT grounds.** It would essentially never
choose SQL: `buildResourceProjection` hands the rows back in memory before the ephemeral database
exists at all, so the TypeScript arm is a for-loop over data already in hand, and the SQL arm's whole
measured share of a run is the 0.0008–0.004 s above. A scheduler would be choosing between two arms
of the 0.1%. And it reintroduces the dependency through the back door: an optimizer that MAY choose
SQL means SQL MAY be needed at check time, which for anyone shipping the thing is the same as
needed. **Optionality is not a property you can keep while also letting a scheduler reach for the
optional thing.**

#### 🔑 Adopter SQL runs unsandboxed on purpose — and contributed SQL is not adopter SQL

What a statement may BE is gated hard, and documented where it is enforced: `assertIsQuery` and
`detachForeignSchemas` in `packages/projection-sqlite/src/store.ts` refuse `ATTACH` and `PRAGMA`,
with the measured cross-repository leak that motivated both, and `CHANGELOG.md`'s `--budget` entry
carries why nothing inside this process can interrupt a runaway statement.

Everything PAST those gates is unsandboxed deliberately. A `.sql` file the adopter points their own
config at is adopter code, at the same trust boundary as their eslint config: they wrote it or they
chose to inherit it, and VAT is not the thing standing between a project and its own repository.

🚨 That reasoning covers exactly ONE trust domain, and the rule scoping it is the other half:
**contributed SQL is a reviewed EXAMPLE, never an auto-executed check.** A contribution channel is
third-party text, and a statement arriving through one has none of the "they chose it" the paragraph
above rests on. Ship it as documentation an adopter copies into their own `resources.checks`
deliberately. One paragraph must not be stretched to cover both domains.

#### 🚨 The population is charged to NOBODY, and the clock proves it

A check's published `durationSecs` is the STATEMENT alone. The git tracker, the projection build and
the load into the ephemeral database happen ONCE and serve every check in the run, so folding that
shared setup into each rule would make N cheap rules look expensive and make the per-rule numbers sum
to N times a cost paid once. It is published separately instead — `populationSecs` beside
`population` — so a reader reconciles the parts against `durationSecs` rather than inferring the
remainder and attributing it to whichever rule they happen to be reading.

🪤 This repo has already shipped the opposite mistake once, in another instrument: `parse ab`
reported a pooled arm BACKWARDS because its estimate was thread-summed, and the report surfaced no
caveat that would have told the reader. A shared cost silently attributed to one participant is the
same defect wearing different clothes. If you ever want the population inside these numbers, divide
it out explicitly and say so in the field name.

The span is enforced structurally: it is the thunk handed to `timed`, which exists for that reason.
⚠️ `performance.now()`, never `Date.now()` — a rule over a small projection is routinely
sub-millisecond, and a millisecond-granularity clock reports every one as `0`, which reads as "not
measured". 🪤 Exactly one cost record per executed check, on both paths, because `checksRun` is that
list's length; the record is filed before the rows become findings, so nothing between the two can
leave a check unpriced.

#### 🚨 Why the loop announces a check before it can be stopped

The progress sink is told a check is about to run, and told again when it is priced. That ordering is
not decoration: this verb runs adopter-authored SQL unattended, an accidental cross join or an
unterminated `WITH RECURSIVE` runs forever, and NOTHING in-process can interrupt it — the query is
synchronous, it holds the event loop, and `node:sqlite` exposes no interrupt. The supervisor's only
lever is an external `SIGKILL`, which publishes nothing of the killed process's memory. So the name
of the rule that hangs has to be on disk BEFORE it is entered, or it is not recoverable at all.

#### What this does not do

It does not fold into `vat resources validate`. That command is on every adopter's pre-commit path,
and adding a store-backed population to it is a cost and a risk that deserves its own decision with
its own evidence. Wiring this into CI is one line in a workflow; making it unavoidable is not this
change's call to make.

## Build Process

### CLI Package Build

```json
{
  "scripts": {
    "build": "tsc && node ../dev-tools/dist/prepare-bin.js"
  }
}
```

**Steps:**
1. TypeScript compilation: `tsc` generates `dist/`
2. Binary preparation: Copy `dist/bin/vat.js` → `dist/bin/vat`, chmod +x

### Dev Tools

**`packages/dev-tools/src/prepare-bin.ts`**
- Makes CLI binaries executable
- Cross-platform (fs.copyFileSync, fs.chmodSync)

**`packages/cli/src/utils/help-loader.ts`**
- Loads markdown documentation from `packages/cli/docs/` at runtime
- Single source of truth for CLI help
- No build-time generation needed

## Design Patterns from vibe-validate

### What We Mirror

✅ Two-tier wrapper (umbrella → CLI package)
✅ Smart context detection (dev/local/global)
✅ Commander.js structure
✅ YAML-first output on stdout
✅ Logs/errors on stderr
✅ Explicit stdout flushing before stderr
✅ `--help --verbose` → markdown documentation
✅ Runtime markdown loading (no build-time generation)
✅ Cross-platform build tools (Node.js APIs)
✅ Test-format error output (file:line:column: message)

### What We Change

🔄 Single command name (`vat` only)
🔄 Scoped commands by package (`vat resources`)
🔄 Config file: `vibe-agent-toolkit.config.yaml` (verbose, discoverable)
🔄 Explicit context override: `VAT_ROOT_DIR` env var (hybrid approach)
🔄 Version display includes context path in dev mode

## Cross-Platform Requirements

- Use `safePath.join()` / `safePath.resolve()` from `@vibe-agent-toolkit/utils` for all paths (raw `node:path` is a lint error, `local/no-raw-node-path`)
- Use Node.js APIs (fs, child_process) instead of shell commands
- Test on Windows, macOS, Linux in CI
- Handle line endings properly (CRLF vs LF)

## Error Handling

- Exit codes are `ExitCode` from `@vibe-agent-toolkit/schema` — `OK` (0) nothing at error
  severity; `FINDINGS` (1) the run completed and what it examined failed its gate; `ERROR` (2) the
  command could not do its job (usage, environment, internal). A literal `process.exit(n)` is a
  lint error (`local/no-literal-process-exit`).
- Always flush stdout before writing to stderr
- Test format errors must include file:line:column

Use the `handleCommandError` helper for consistent error handling:

```typescript
try {
  // Command implementation
} catch (error) {
  handleCommandError(error, logger, startTime, 'CommandName');
  // handleCommandError calls process.exit() internally
}
```

This ensures a consistent error format, duration logging, and the exit codes above (`FINDINGS`
for a gate the tree failed, `ERROR` for a command that could not do its job).

## Testing Patterns

### System Tests

Create system tests in `test/system/` for end-to-end CLI testing:

```typescript
describe('MyCommand (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-mycommand-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle basic usage', () => {
    const { result, parsed } = executeCommandAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should handle errors correctly', () => {
    // Test error scenarios with exit code 1 or 2
  });
});
```

Help-text test patterns (verifying `--help` output) are covered by
[`.claude/rules/cli-help-text.md`](../../.claude/rules/cli-help-text.md), which fires whenever
you touch a command file.

## References

- [vibe-validate CLI](https://github.com/jdutton/vibe-validate) - Pattern source
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [Package Architecture](./README.md) - Overall package structure
