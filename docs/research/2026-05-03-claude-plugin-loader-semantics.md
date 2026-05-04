---
title: "Claude Code Plugin Loader Semantics"
date: 2026-05-04
status: partially-conclusive
related-spec: docs/superpowers/specs/2026-05-03-plugin-inventory-architecture-design.md
---

# Claude Code Plugin Loader Semantics

**Date:** 2026-05-04
**Author:** Claude (Sonnet) under Jeff Dutton's direction
**Status:** Partially conclusive — source review yielded significant evidence; empirical install runbook not yet executed.

---

## Question

The four new validation codes shipping in Tasks 3.2/3.3 of the Plugin Inventory Architecture plan need
severity defaults. Two of them depend on what Claude Code actually does when `plugin.json` declares a
skill that does not exist on disk, or when a skill directory exists on disk but is not declared:

- `COMPONENT_DECLARED_BUT_MISSING` — proposed default: `warning`
- `COMPONENT_PRESENT_BUT_UNDECLARED` — proposed default: `info`

The two other codes are clear-cut regardless of loader behavior:

- `REFERENCE_TARGET_MISSING` — proposed default: `error` (dead link in a skill file)
- `MARKETPLACE_PLUGIN_SOURCE_MISSING` — proposed default: `error` (marketplace references non-existent plugin)

If Claude Code silently skips a declared-but-missing skill path, `warning` is appropriate.
If it errors at install time or fails to install the plugin entirely, `error` would be more accurate.
Similarly, if Claude Code auto-discovers undeclared skills in `skills/` directories, `COMPONENT_PRESENT_BUT_UNDECLARED`
at `info` appropriately signals "you may have more than you think" rather than a real defect.

---

## Methods Attempted

### Method 1: Source Review (2026-05-04)

**Target:** Claude Code v2.1.126 (current installation at `~/.local/share/claude/versions/2.1.126`),
VS Code extension v2.1.123 (at `~/.vscode/extensions/anthropic.claude-code-2.1.123-darwin-arm64/`).

**GitHub repo status:** As of 2026-05-04, `https://github.com/anthropics/claude-code` remains
closed-source. The repository exists as a public issues tracker but does not contain loader source code.

**Finding:** The Claude Code CLI binary (`2.1.126`) is a Mach-O ARM64 executable that embeds a Bun
JavaScript bundle (runtime: `bun`, inferred from `/$bunfs/root/` native module paths in the bundle
strings). The bundle is minified and obfuscated via name-mangling (single/double-letter variable names)
but is **not encrypted**. The `strings` utility and targeted grep against the binary produced the
actual plugin loader source code (minified form).

The VS Code extension (`extension.js`, ~1.9 MB) contains the same bundle embedded for the extension
host. Both sources yielded identical relevant code sections.

**Confidence:** High. The code sections extracted are internally consistent and reference known
Claude Code concepts (`.claude-plugin`, `skills/`, `SKILL.md`, `plugin.json`).

### Method 2: Empirical Install Runbook

The empirical install test (running `claude /plugin install` against each fixture) was **not executed**.
This requires an interactive Claude Code session and must be run by the maintainer separately.
See the [Runbook](#runbook-for-empirical-verification) section below.

---

## Source Code Findings

The following pseudo-code is a faithful reconstruction from the minified bundle. Variable names are
translated from single-letter mangled form based on context. Source location: binary strings at
approximate line range 135657–138182 (both in CLI binary and VS Code extension bundle).

### Function: `cd9` — Plugin Component Discovery

```javascript
// cd9(pluginDir, source, enabled, manifestOptions, strictMode=true)
async function cd9(pluginDir, source, enabled, manifestOptions) {
  let errors = [];
  let { manifest, manifestPath } = await loadManifest(pluginDir, manifestOptions, source);
  let plugin = { name: manifest.name, manifest, path: pluginDir, source, enabled };

  // Auto-discovery: probe for each component directory ONLY if manifest doesn't declare it
  let [
    commandsDirExists,  // !manifest.commands ? stat(join(pluginDir, "commands")) : false
    agentsDirExists,    // !manifest.agents   ? stat(join(pluginDir, "agents"))   : false
    skillsDirExists,    // !manifest.skills   ? stat(join(pluginDir, "skills"))   : false
    outputStylesExists, // !manifest.outputStyles ? stat(join(pluginDir, "output-styles")) : false
    themesExists,       // !manifest.themes   ? stat(join(pluginDir, "themes"))   : false
  ] = await Promise.all([...]);

  // --- SKILLS SECTION ---
  let skillsDefaultPath = join(pluginDir, "skills");

  // Auto-discovery branch: no manifest.skills declared, but skills/ dir found on disk
  if (skillsDirExists) plugin.skillsPath = skillsDefaultPath;

  // Declaration branch: manifest.skills IS declared
  if (manifest.skills) {
    let declaredPaths = Array.isArray(manifest.skills)
      ? manifest.skills
      : [manifest.skills];

    // pQ resolves each path, checks existence, collects errors
    let resolvedPaths = await pQ(
      declaredPaths, pluginDir, manifest.name, source,
      "skills", "Skill", "specified in manifest but", errors
    );
    if (resolvedPaths.length > 0) plugin.skillsPaths = resolvedPaths;
  }
  // ...
}
```

### Function: `pQ` — Path Resolution with Existence Check

```javascript
// pQ(paths, pluginDir, pluginName, source, component, label, errorSuffix, errorsArray)
async function pQ(paths, pluginDir, pluginName, source, component, label, errorSuffix, errorsArray) {
  let resolved = await Promise.all(paths.map(async (relPath) => {
    let fullPath = safeResolve(pluginDir, relPath); // returns null if path escapes plugin dir
    if (fullPath === null) return { relPath, fullPath: null, exists: false };
    return { relPath, fullPath, exists: await pathExists(fullPath) };
  }));

  let validPaths = [];
  for (let { relPath, fullPath, exists } of resolved) {
    if (fullPath === null) {
      // Path traversal attempt — logged at "error" level, push path-traversal event
      log(`${label} path ${relPath} ${errorSuffix} escapes plugin directory for ${pluginName}`, { level: "error" });
      errorsArray.push({ type: "path-traversal", ... });
      continue;
    }
    if (exists) {
      validPaths.push(fullPath);
    } else {
      // Declared path does not exist — logged at "warn" level, push path-not-found event
      log(`${label} path ${relPath} ${errorSuffix} not found at ${fullPath} for ${pluginName}`, { level: "warn" });
      reportError(new Error(`Plugin component file not found: ${fullPath} for ${pluginName}`));
      errorsArray.push({ type: "path-not-found", source, plugin: pluginName, path: fullPath, component });
    }
  }
  return validPaths;
}
```

### Function: `Wm7` — Skills Directory Loader

```javascript
// Wm7(skillsDir, namePrefix, ...) — called when plugin.skillsPath or plugin.skillsPaths resolves
async function Wm7(skillsDir, namePrefix, ...) {
  let results = [];
  let rootSkillMd = join(skillsDir, "SKILL.md");

  // Check for root-level SKILL.md (skill-style plugin shape)
  let rootContent = null;
  try {
    rootContent = await fs.readFile(rootSkillMd, { encoding: "utf-8" });
  } catch (e) {
    if (!isNotFoundError(e)) {
      log(`Failed to load skill from ${rootSkillMd}: ${e}`, { level: "error" });
    }
    // ENOENT: fall through to directory scan
  }

  if (rootContent !== null) {
    // Skill-style plugin: load the root SKILL.md as the single skill and RETURN early
    // (does NOT also scan subdirectories)
    let { frontmatter, content } = parseFrontmatter(rootContent, rootSkillMd);
    let skillName = (frontmatter.name?.trim() || basename(skillsDir)).replace(/[^a-zA-Z0-9_-]/g, "-");
    let skill = buildSkill(`${namePrefix}:${skillName}`, ...);
    if (skill) results.push(skill);
    return results;
  }

  // Directory-scan: enumerate subdirectories, each containing a SKILL.md
  let entries = await fs.readdir(skillsDir);
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
    let subDir = join(skillsDir, entry.name);
    let skillMd = join(subDir, "SKILL.md");
    let content;
    try {
      content = await fs.readFile(skillMd, { encoding: "utf-8" });
    } catch (e) {
      if (!isNotFoundError(e)) {
        log(`Failed to load skill from ${skillMd}: ${e}`, { level: "error" });
      }
      return; // ENOENT: silently skip this subdirectory
    }
    // ... parse and build skill
  }));
  return results;
}
```

---

## Key Loader Behaviors Established by Source Review

### 1. Declared-but-missing skill paths: `warn`-level log, plugin continues loading

When `plugin.json` declares `"skills": ["./skills/foo"]` and `./skills/foo` does not exist on disk,
the `pQ` function:
- Logs a **`warn`-level** message: `"Skill path ./skills/foo specified in manifest but not found at <full-path> for <plugin-name>"`
- Pushes a `{ type: "path-not-found" }` error event into the plugin's error collection
- **Does NOT throw.** The plugin continues loading; only the missing paths are excluded from `skillsPaths`
- Reports a non-fatal `Error` internally (captured but not re-thrown)

**Conclusion:** A declared-but-missing skill causes a logged warning and a `path-not-found` event, but
does NOT block plugin installation or cause a fatal error. The skill is simply absent from the session.
The user sees no interactive error; they only notice the skill is missing when they try to invoke it.

### 2. Present-but-undeclared skills: auto-discovered via `skills/` dir probe

When `plugin.json` has **no** `"skills"` field, the loader's `cd9` function checks whether `skills/`
exists on disk:

```javascript
// !manifest.skills ? stat(join(pluginDir, "skills")) : false
let skillsDirExists = !manifest.skills ? await pathExists(join(pluginDir, "skills")) : false;
if (skillsDirExists) plugin.skillsPath = skillsDefaultPath;
```

If `skills/` is present without a declaration, the loader **auto-discovers** it and sets `skillsPath`.
The `Wm7` function then loads all subdirectory `SKILL.md` files from it.

**Conclusion:** Skills present on disk but not declared in `plugin.json` ARE loaded automatically,
as long as the `skills/` directory exists. The `"skills"` field in `plugin.json` is only needed when
the skills are in non-default paths (i.e., not `./skills/`). This behavior is consistent with a
"convention over configuration" design.

### 3. Skill-style plugin (root `SKILL.md`): loaded via `skillsPath` on the plugin object

The `Wm7` function handles the "skill-style plugin" case by checking for `SKILL.md` directly at the
path passed as `skillsDir`. If found, it loads that as the skill and returns without scanning
subdirectories. This means:

- A root-level `SKILL.md` at `pluginDir/SKILL.md` is NOT auto-discovered by `cd9` (it would need
  to be either declared as `"skills": ["."]` or the plugin root itself would need to be treated as
  the skill directory).
- The `skill-claude-plugin-mixed` fixture case (root `SKILL.md` + declared `./skills/bar`) would
  load `./skills/bar/SKILL.md` via the declared path and would NOT load the root `SKILL.md` unless
  the root itself is passed as a skill path.

### 4. Auto-discovery is suppressed by any declaration in the manifest

The ternary `!manifest.skills ? stat(...) : false` means: once `skills` is declared in the manifest
(even as an empty array), the auto-discovery probe is **skipped entirely**. The loader defers
completely to the declared paths. This is an important edge case for the `COMPONENT_PRESENT_BUT_UNDECLARED`
code: if a manifest declares `"skills": []`, a `skills/foo/SKILL.md` on disk is NOT auto-discovered
and IS silently absent.

---

## Findings Table

| Fixture | Shape | Declared in manifest | Exists on disk | Loader behavior (from source) | Plugin installs? | Skill available? |
|---------|-------|---------------------|----------------|-------------------------------|-----------------|-----------------|
| `declared-and-present` | `.claude-plugin` | `./skills/foo` | Yes | `pQ` resolves path, adds to `skillsPaths` | Yes | Yes |
| `declared-but-missing` | `.claude-plugin` | `./skills/foo` | No | `pQ`: warn-level log + `path-not-found` event, path excluded | Yes (plugin loads) | No (skill absent) |
| `present-but-undeclared` | `.claude-plugin` | None | `skills/foo/SKILL.md` | `cd9` auto-discovers `skills/` dir, `Wm7` loads subdirectories | Yes | Yes (auto-loaded) |
| `skill-claude-plugin-mixed` | Mixed | `./skills/bar` declared; root `SKILL.md` present | Both | Bar loaded via `pQ`; root SKILL.md NOT loaded (not in `skillsPath`) | Yes | Bar only |
| *(empirical — TBD)* | — | — | — | Columns 5–7 need interactive verification | TBD | TBD |

*Columns "Plugin installs?" and "Skill available?" in rows 2–4 are inferred from source code analysis.
The empirical runbook below should confirm.*

---

## Runbook for Empirical Verification

**Prerequisites:** Interactive Claude Code session (v2.1.126+), terminal access.

**For each fixture, run the following steps and fill in the observations table below.**

### Step 1: Install the fixture as a plugin

```bash
# From the vibe-agent-toolkit repo root:
cd docs/research/fixtures/loader-semantics

# Install each fixture (run in separate shell sessions or uninstall between tests):
claude /plugin install ./declared-and-present
claude /plugin install ./declared-but-missing
claude /plugin install ./present-but-undeclared
claude /plugin install ./skill-claude-plugin-mixed
```

### Step 2: Inspect the result for each fixture

After each install attempt, check:

1. **Install succeeded?** — Did Claude Code report an error, or did it confirm install?
2. **`/skills` listing** — Run `/skills` (or check Claude's skill roster) and note which skills appear.
3. **stderr / log output** — Check `~/.claude/logs/` or the terminal for warning/error messages.
   - Look for: `"Skill path ... not found"`, `"path-not-found"`, `"warn"` level entries.
4. **Skill invocation** — Try running each skill by name. Does Claude respond or report the skill missing?

### Step 3: Observations table (fill in after running)

| Fixture | Install succeeded? | Skills visible in `/skills`? | Any warn/error in logs? | Log excerpt (if any) |
|---------|-------------------|------------------------------|------------------------|----------------------|
| `declared-and-present` | TBD | TBD | TBD | — |
| `declared-but-missing` | TBD | TBD | TBD | — |
| `present-but-undeclared` | TBD | TBD | TBD | — |
| `skill-claude-plugin-mixed` | TBD | TBD | TBD | — |

### Step 4: Log directory check

```bash
# Check for recent plugin-loading log entries:
ls -lt ~/.claude/logs/ | head -5
# Open the most recent log and search for the plugin names above:
grep -i "declared-but-missing\|present-but-undeclared\|path-not-found\|warn" ~/.claude/logs/<latest>.log | head -20
```

---

## Implication for Severity Defaults

Based on the source code findings above:

### `COMPONENT_DECLARED_BUT_MISSING` — ship at `warning` (spec default)

**Rationale:** Source code confirms the loader itself uses `warn`-level for this case and does NOT
block plugin installation. The user loses the skill silently — they only notice at invocation time.
This is a defect worth flagging but not an outright error. The spec default of `warning` is
appropriate and aligns with Claude Code's own severity judgment.

**Promotion to `error` threshold:** If empirical testing reveals the plugin installation fails
entirely (not just the skill being absent) in some Claude Code version, the code should be
promoted. The source review alone does not show that outcome, but the runbook above would confirm it.

### `COMPONENT_PRESENT_BUT_UNDECLARED` — ship at `info` (spec default)

**Rationale:** Source code confirms present-but-undeclared skills ARE auto-discovered when in the
default `skills/` directory (no manifest declaration needed). This means the absence of a declaration
is not a defect — it's the supported default usage pattern. Flagging it at anything higher than `info`
would produce false positives for every plugin that uses the convention-over-configuration approach.

The one edge case where absence of declaration does matter: if the manifest has `"skills": []` (empty
array), the auto-discovery probe is suppressed and on-disk skills are NOT loaded. That scenario
would be a genuine bug worth surfacing, but it falls under `COMPONENT_DECLARED_BUT_MISSING` (empty
array = declared with zero paths) rather than `COMPONENT_PRESENT_BUT_UNDECLARED`.

**Conclusion:** `info` is the right default. The code fires when `declared !== null` (i.e., when a
manifest exists but lists no skills), which is the conservative behavior already in the spec.

### `REFERENCE_TARGET_MISSING` — ship at `error` (spec default)

**Rationale:** A skill that links to a non-existent file has a broken reference regardless of loader
behavior. This is a content defect, not a packaging defect. `error` is appropriate.

### `MARKETPLACE_PLUGIN_SOURCE_MISSING` — ship at `error` (spec default)

**Rationale:** A marketplace manifest that references a plugin directory that does not exist means the
marketplace entry is dangling. Claude Code would fail to install such a plugin. `error` is appropriate.

---

## Outstanding Unknowns

The empirical runbook (not yet executed) would clarify:

1. **Does a `path-not-found` event surface to the user during `claude /plugin install`?** Source shows
   it's collected in an errors array but not necessarily displayed. If it IS displayed as an install
   error (not just a log entry), `COMPONENT_DECLARED_BUT_MISSING` should be promoted to `error`.

2. **Does the `path-not-found` errors array affect plugin `enabled` status?** The `cd9` function
   collects errors but the code section reviewed does not show whether a non-empty errors array sets
   `enabled: false`. This could change the severity recommendation significantly.

3. **Root `SKILL.md` + `.claude-plugin/plugin.json` coexistence:** The source shows `Wm7` stops at
   a root-level `SKILL.md` and does not scan subdirectories. But how does `cd9` pass the path to
   `Wm7` in this case? If the plugin root itself is set as `skillsPath`, the root SKILL.md is the
   skill. If `./skills` is the `skillsPath`, subdirectories are scanned. The `skill-claude-plugin-mixed`
   fixture would clarify whether a root SKILL.md is ever loaded when `plugin.json` also declares a
   skills path.

4. **Version sensitivity:** Behavior was extracted from v2.1.126. Prior or future versions may differ.
   The runbook should note the Claude Code version at test time.

5. **`skills/` auto-discovery with empty `"skills": []` vs. missing `"skills"` key:** Source clearly
   distinguishes these (`!manifest.skills` is falsy for `undefined` but truthy for `[]`... actually
   `[]` is truthy in JS, so `![]` is `false` — meaning an empty array DOES suppress auto-discovery).
   This edge case should be empirically confirmed.

---

## Decision: Ship at Spec Defaults

Given the partial but substantive source evidence, and following the inconclusive-evidence rule from
the Plugin Inventory Architecture spec: **ship all four codes at their spec defaults**.

| Code | Spec default | Source evidence | Change? |
|------|-------------|----------------|---------|
| `COMPONENT_DECLARED_BUT_MISSING` | `warning` | Loader uses `warn`-level; plugin loads without skill | No change |
| `COMPONENT_PRESENT_BUT_UNDECLARED` | `info` | Auto-discovery makes undeclared skills normal usage | No change |
| `REFERENCE_TARGET_MISSING` | `error` | Clear-cut; independent of loader behavior | No change |
| `MARKETPLACE_PLUGIN_SOURCE_MISSING` | `error` | Clear-cut; independent of loader behavior | No change |

The spec defaults stand. Severity promotions should be gated on empirical runbook results or corpus
scan data showing the severity is systematically wrong in practice.
