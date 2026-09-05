# vat doctor - Environment Diagnostics

## Overview

The `vat doctor` command diagnoses common issues with your agent project setup and environment,
providing actionable suggestions for any problems found.

## Command

### vat doctor [options]

**Purpose:** Check environment and project setup health

**What it checks:**
1. Node.js version (>=20 required)
2. Git installed and version
3. Current directory is a git repository
4. Configuration file exists (vibe-agent-toolkit.config.yaml)
5. Configuration is valid YAML with correct schema
6. VAT version (checks npm for updates)
7. CLI build status (when running from VAT source tree)

**Options:**
- `--verbose` - Show all checks (including passing and skipped ones)

**Check outcomes:**

| Icon | Outcome | Meaning |
|------|---------|---------|
| ✅ | `pass` | The check ran and the thing is fine |
| ❌ | `fail` | The check ran and the thing is wrong — the only outcome that affects the exit code |
| ❓ | `undetermined` | The check could not reach an answer (registry unreachable, file unreadable). **Nothing was verified** — this is not a pass |
| ⏭️ | `skipped` | The check does not apply here (e.g. a VAT-source-tree-only check outside the source tree) |

**Exit Codes:**
- `0` - No check failed (an undetermined check is reported in the output, not fatal)
- `1` - One or more checks failed

**Output:** Human-friendly formatted text with emojis. The summary always prints the
full outcome distribution and, when the concise view hides checks, how many it hid —
so the counts can never contradict the list above them.

## Usage Examples

### Basic Check

Check all diagnostic items and show only failures:

```bash
vat doctor
```

Output when all checks pass (the concise view prints no check blocks, and says so):
```
🩺 vat doctor

Running diagnostic checks...

📊 Results: 7 checks — 7 passed, 0 failed, 0 undetermined, 0 skipped
   7 not shown (nothing to report) — re-run with --verbose to see every check.

✨ All checks passed! Your vat setup looks healthy.
```

Output when a check could not be determined (here: the npm registry was unreachable):
```
🩺 vat doctor

Running diagnostic checks...

❓ vat version
   Unable to check for updates: not found: npm

📊 Results: 7 checks — 6 passed, 0 failed, 1 undetermined, 0 skipped
   6 not shown (nothing to report) — re-run with --verbose to see every check.

❓ Nothing failed, but 1 check(s) could not be determined — that is not the same as healthy.
```
Exit code is still `0` — nothing failed — but the run is *not* reported as healthy.

### Verbose Mode

Show all checks including passing ones:

```bash
vat doctor --verbose
```

Output shows all individual checks:
```
🩺 vat doctor

Running diagnostic checks...

✅ vat version
   Current: 0.1.0 — up to date

✅ Node.js version
   v22.13.0 (meets requirement: >=22.13.0)

✅ Git installed
   git version 2.43.0

✅ Git repository
   Current directory is a git repository

✅ Configuration file
   Found: vibe-agent-toolkit.config.yaml

✅ Configuration valid
   Configuration is valid

✅ CLI build status
   Build is up to date (v0.1.0)

📊 Results: 7 checks — 7 passed, 0 failed, 0 undetermined, 0 skipped

✨ All checks passed! Your vat setup looks healthy.
```

## Project Context Detection

When run from a subdirectory, doctor shows project context:

```bash
cd packages/cli
vat doctor
```

Output:
```
🩺 vat doctor

📍 Project Context
   Current directory: /path/to/project/packages/cli
   Project root:      /path/to/project
   Configuration:     /path/to/project/vibe-agent-toolkit.config.yaml

Running diagnostic checks...

📊 Results: 7 checks — 7 passed, 0 failed, 0 undetermined, 0 skipped
   7 not shown (nothing to report) — re-run with --verbose to see every check.

✨ All checks passed! Your vat setup looks healthy.
```

## Troubleshooting

When checks fail, doctor provides specific suggestions:

### Node.js Version Too Old

```
❌ Node.js version
   v18.0.0 is too old. Node.js 20+ required.
   💡 Upgrade Node.js: https://nodejs.org/ or use nvm
```

### Git Not Installed

```
❌ Git installed
   Git is not installed
   💡 Install Git: https://git-scm.com/
```

### Not a Git Repository

```
❌ Git repository
   Current directory is not a git repository
   💡 Run: git init
```

### Configuration File Missing

```
❌ Configuration file
   Configuration file not found
   💡 Create vibe-agent-toolkit.config.yaml in project root
```

### Configuration Invalid

```
❌ Configuration valid
   Configuration contains errors: YAML syntax error at line 5
   💡 Fix YAML syntax or schema errors in vibe-agent-toolkit.config.yaml
```

### VAT Update Available

```
✅ vat version
   Current: 0.1.0, Latest: 0.2.0 available
   💡 Upgrade: npm install -g vibe-agent-toolkit@latest
```

### CLI Build Stale (VAT Source Tree)

```
❌ CLI build status
   Build is stale: running v0.1.0, source v0.2.0
   💡 Rebuild packages: bun run build
```

## Use Cases

### Before Starting Development

Run doctor to ensure your environment is set up correctly:

```bash
vat doctor
```

### After Updating VAT

Check that everything still works after upgrading:

```bash
npm install -g vibe-agent-toolkit@latest
vat doctor
```

### Debugging Issues

Use verbose mode to see all check details:

```bash
vat doctor --verbose
```

### CI/CD Integration

Use exit codes for automated checks:

```bash
if vat doctor; then
  echo "Environment healthy"
else
  echo "Environment issues detected"
  exit 1
fi
```

## Check Details

### Node.js Version Check

- **Requirement:** Node.js 20 or higher
- **Why:** VAT uses modern JavaScript features
- **Fix:** Install Node.js from https://nodejs.org/ or use nvm

### Git Installation Check

- **Requirement:** Git command available
- **Why:** VAT projects are typically git repositories
- **Fix:** Install Git from https://git-scm.com/

### Git Repository Check

- **Requirement:** Current directory is in a git repository
- **Why:** VAT works best with version-controlled projects
- **Fix:** Run `git init` to initialize a repository

### Configuration File Check

- **Requirement:** vibe-agent-toolkit.config.yaml exists
- **Location:** Searches up directory tree from current location
- **Fix:** Create configuration file in project root

### Configuration Valid Check

- **Requirement:** Configuration file is valid YAML with correct schema
- **Why:** Invalid config causes runtime errors
- **Fix:** Validate YAML syntax and check required fields

### VAT Version Check

- **Purpose:** Inform about available updates (advisory only)
- **Never fails:** an available update is a `pass` with a suggestion
- **Undetermined:** if the npm registry cannot be reached, the outcome is
  `undetermined` (❓), not `pass` — doctor did not verify that you are current
- **Suggestion:** Shows upgrade command if update available

### CLI Build Status Check

- **When:** Only runs when in VAT source tree
- **Purpose:** Ensure CLI build matches source version (for VAT developers)
- **Skipped (⏭️):** When running installed VAT globally, or when no project root
  was detected — the check does not apply
- **Undetermined (❓):** When the version files exist but cannot be read or
  parsed. Doctor cannot tell whether the build is stale, which is different from
  the check not applying
- **Fix:** Run `bun run build` in VAT source directory

## Requirements

- **`projectRoot`**: optional. `vat doctor` tolerates a missing `projectRoot`
  and reports its absence as a diagnostic finding rather than refusing to run.
  This is by design: doctor is the command users invoke when they suspect their
  setup is wrong, so it must run anywhere.
- **Config**: not used as input. Doctor checks whether a config file *exists*
  and parses as a finding, but it does not consume config fields to drive its
  behavior.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for terminology.

## Tips

- Run `vat doctor` before reporting issues to verify environment
- Use `--verbose` flag when debugging to see all check details
- Doctor checks can be run from any subdirectory in your project
- Exit code 0 means no check *failed*; read the counts line to see whether any
  check was undetermined (useful for scripts)
