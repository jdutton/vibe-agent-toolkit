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
- `--verbose` - Show all checks (including passing ones)

**Exit Codes:**
- `0` - All checks passed
- `1` - One or more checks failed

**Output:** Human-friendly formatted text with emojis

## Usage Examples

### Basic Check

Check all diagnostic items and show only failures:

```bash
vat doctor
```

Output when all checks pass:
```
🩺 vat doctor

Running diagnostic checks...

📊 Results: 7/7 checks passed

✨ All checks passed! Your vat setup looks healthy.
```

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
   v22.0.0 (meets requirement: >=20.0.0)

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

📊 Results: 7/7 checks passed

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

📊 Results: 7/7 checks passed

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
- **Always passes:** This check never fails
- **Suggestion:** Shows upgrade command if update available

### CLI Build Status Check

- **When:** Only runs when in VAT source tree
- **Purpose:** Ensure CLI build matches source version (for VAT developers)
- **Skipped:** When running installed VAT globally
- **Fix:** Run `bun run build` in VAT source directory

## Tips

- Run `vat doctor` before reporting issues to verify environment
- Use `--verbose` flag when debugging to see all check details
- Doctor checks can be run from any subdirectory in your project
- Exit code 0 means all checks passed (useful for scripts)
