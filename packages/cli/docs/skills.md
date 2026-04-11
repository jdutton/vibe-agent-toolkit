# vat skills - Claude Code Skills Commands

## Overview

The `vat skills` commands provide tools for packaging, distributing, installing, and managing Claude Code skills. These commands support the full skill lifecycle from development to distribution to installation.

## Commands

### vat skills validate [path]

**Purpose:** Validate SKILL.md files for correctness and best practices

**What it does:**
1. Discovers all SKILL.md files in the target directory
2. Validates both resource rules (links, frontmatter) and skill-specific rules
3. Reports errors and warnings in structured format
4. Exits 0 if valid, 1 if errors found (warnings don't fail)

**Validation Modes:**

**Project mode (default):**
- Respects `vibe-agent-toolkit.config.yaml` boundaries
- Strict filename validation - must be exactly "SKILL.md" (case-sensitive)
- Errors on non-standard filenames (skill.md, Skill.md, etc.)

**User mode (--user flag):**
- Scans `~/.claude/plugins` and `~/.claude/skills`
- Permissive validation - non-standard filenames generate warnings only
- More tolerant for user-installed content

**Path mode (explicit path):**
- Scans specified directory
- Strict filename validation like project mode

**Arguments:**
- `[path]` - Path to validate (defaults to current directory)

**Options:**
- `--user` - Validate user-installed skills in ~/.claude
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - All validations passed
- `1` - Validation errors found (warnings don't fail)
- `2` - System error (directory not found, config invalid)

**Validation Checks:**

*Resource validation:*
- Internal file links (relative paths)
- Anchor links within files (#heading)
- Cross-file anchor links (file.md#heading)
- Frontmatter schema validation

*Skill-specific validation:*
- Reserved word checks (name field)
- XML tag detection (name/description fields)
- Console compatibility warnings
- Required frontmatter fields (name, description)

*Filename validation:*
- Must be "SKILL.md" (uppercase)
- Strict mode: errors on skill.md, Skill.md
- Permissive mode: warnings only

**Output Format:**
```yaml
status: success | error
skillsValidated: 3
results:
  - path: resources/skills/SKILL.md
    status: success
    skill:
      name: my-skill
      description: Skill description
    issues: []
durationSecs: 0.245
```

**Examples:**
```bash
# Validate all project skills (default)
vat skills validate

# Validate user-installed skills
vat skills validate --user

# Validate specific directory
vat skills validate packages/my-agent/resources/skills
```

---

### vat skills build

**Purpose:** Build skills from package.json metadata during package build

**What it does:**
1. Reads `vat.skills` array from package.json
2. Validates each skill source exists
3. Runs `packageSkill()` for each skill
4. Outputs to configured path directories

**Typical Usage:**
```json
{
  "scripts": {
    "build": "tsc && vat skills build"
  }
}
```

**Package.json Structure:**
```json
{
  "vat": {
    "version": "1.0",
    "type": "agent-bundle",
    "skills": [
      {
        "name": "my-skill",
        "source": "./resources/skills/SKILL.md",
        "path": "./dist/skills/my-skill"
      }
    ]
  }
}
```

**Options:**
- `--skill <name>` - Build specific skill only
- `--dry-run` - Preview build without creating files
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Build successful (or dry-run preview)
- `1` - Invalid source or build error
- `2` - System error (missing package.json, invalid config)

**Output Format:**
```yaml
status: success
package: @my-org/my-package
skillsBuilt: 2
skills:
  - name: skill1
    outputPath: /path/to/dist/skills/skill1
    filesPackaged: 5
  - name: skill2
    outputPath: /path/to/dist/skills/skill2
    filesPackaged: 3
duration: 1234ms
```

**Examples:**
```bash
# Build all skills from package.json
vat skills build

# Build specific skill
vat skills build --skill my-skill

# Preview without building
vat skills build --dry-run
```

---

### vat skills package <skill-path>

**Purpose:** Package a SKILL.md file for distribution

**What it does:**
1. Validates the SKILL.md file
2. Recursively collects all linked markdown files
3. Rewrites relative links to maintain correctness after relocation
4. Creates distributable artifacts (directory, ZIP, npm, marketplace)

**Arguments:**
- `<skill-path>` - Path to SKILL.md file (required)

**Required Options:**
- `-o, --output <path>` - Output directory for packaged skill (required)

**Optional Options:**
- `-f, --formats <formats>` - Comma-separated formats: directory,zip,npm,marketplace (default: directory,zip)
- `--no-rewrite-links` - Skip rewriting relative links in copied files
- `-b, --base-path <path>` - Base path for resolving relative links (default: dirname of SKILL.md)
- `--dry-run` - Preview packaging without creating files
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Packaging successful (or dry-run preview)
- `1` - Invalid skill path or packaging error
- `2` - System error

**What Gets Packaged:**
- Root SKILL.md file
- All linked markdown files (recursively discovered)
- Links are rewritten to maintain correctness
- Directory structure is preserved

**Output Format:**
```yaml
status: success
skill: my-skill
version: 1.0.0
outputPath: /path/to/output/my-skill
filesPackaged: 8
artifacts:
  directory: /path/to/output/my-skill
  zip: /path/to/output/my-skill.zip
duration: 456ms
```

**Examples:**
```bash
# Package with default formats (directory + ZIP)
vat skills package resources/skills/SKILL.md -o dist/my-skill

# Preview without creating files
vat skills package SKILL.md -o /tmp/skill --dry-run

# Package as ZIP and npm formats only
vat skills package SKILL.md -o dist -f zip,npm

# Package without rewriting links
vat skills package SKILL.md -o dist --no-rewrite-links

# Package with custom base path
vat skills package SKILL.md -o dist -b /custom/base
```

---

### vat skills install \<source\>

**Purpose:** Install a SKILL.md-based skill to one of 7 supported platform targets

**What it does:**
1. Resolves the source (local directory, ZIP, .tgz, or npm package)
2. Discovers one or more skills inside the source
3. Pre-validates every skill with `validateSkill()` — zero files written if validation fails
4. Builds an install plan, detecting conflicts before touching the filesystem
5. Copies skill(s) to the resolved platform directory (all-or-nothing semantics)
6. Emits a YAML summary on stdout

Both `--target` and `--scope` are **required** — there are no defaults.

**Supported Sources:**
- **Local directory:** `./path/to/skill-dir` — must contain `SKILL.md` at root or in subdirectories
- **Local ZIP file:** `./path/to/skill.zip` — extracted to a temp directory, then installed
- **Local tarball:** `./path/to/skill.tgz` or `skill.tar.gz` — extracted as an npm package tarball
- **npm package:** `npm:@scope/package-name` — downloaded from the registry, `dist/skills/` is used

**Arguments:**
- `<source>` - Source to install from (required)

**Required Options:**
- `--target <target>` - Platform target (see Targets table below)
- `--scope <scope>` - Install scope: `user` or `project`

**Optional Options:**
- `-n, --name <name>` - Override skill name (single-skill sources only)
- `-f, --force` - Overwrite existing skill
- `--dry-run` - Preview install without writing files
- `--debug` - Enable debug logging

**Targets:**

| Target | User path | Project path |
|--------|-----------|--------------|
| `claude` | `~/.claude/skills/` | `.claude/skills/` |
| `codex` | `~/.agents/skills/` | `.agents/skills/` |
| `copilot` | `~/.copilot/skills/` | `.github/skills/` |
| `gemini` | `~/.gemini/skills/` | `.gemini/skills/` |
| `cursor` | `~/.cursor/skills/` | `.cursor/skills/` |
| `windsurf` | `~/.codeium/windsurf/skills/` | `.windsurf/skills/` |
| `agents` | `~/.agents/skills/` | `.agents/skills/` |

**Exit Codes:**
- `0` - Install successful (or dry-run complete)
- `1` - Install error (validation failed, conflict without `--force`, source not found, bad target/scope)
- `2` - System error (unexpected exception)

**YAML Output Format:**
```yaml
---
status: success          # or dry-run on --dry-run
source: /abs/path/to/source
target: claude
scope: user
skillsInstalled: 2
skills:
  - name: my-skill
    installPath: /Users/you/.claude/skills/my-skill
  - name: other-skill
    installPath: /Users/you/.claude/skills/other-skill
duration: 234ms
```

On error, stdout receives:
```yaml
---
status: error
error: <first line of error message>
duration: 234ms
```

**All-or-nothing semantics:** Skills are pre-verified before any filesystem writes. If any skill fails validation, or if a conflict is detected (without `--force`), the entire install is aborted and no files are written.

**Examples:**
```bash
# Install from local built skill directory to user-scoped Claude
vat skills install ./dist/skills/my-skill --target claude --scope user

# Install from ZIP to project-scoped Copilot
vat skills install ./my-skill.zip --target copilot --scope project

# Install from tarball
vat skills install ./my-skill.tgz --target gemini --scope user

# Install from npm package
vat skills install npm:@vibe-agent-toolkit/vat-development-agents --target claude --scope user

# Override skill name (single-skill sources only)
vat skills install ./dist/skills/my-skill --target claude --scope user --name custom-name

# Force overwrite existing skill
vat skills install ./dist/skills/my-skill --target claude --scope user --force

# Preview installation without writing files
vat skills install npm:@my-org/package --target cursor --scope user --dry-run

# Install to project scope
vat skills install ./dist/skills/my-skill --target claude --scope project
```

**Post-Installation:**
After installation, you need to:
1. Restart Claude Code (or the target agent), or
2. Run `/reload-skills` in Claude Code to load the new skill

---

### vat skills list [path]

**Purpose:** List skills in project or user installation

**What it does:**
1. Discovers all SKILL.md files in the target location
2. Reports validation status for each skill
3. Shows skill metadata (name, description, path)

**Modes:**

**Project mode (default):**
- Lists skills in project directory
- Respects `vibe-agent-toolkit.config.yaml` boundaries
- Strict filename validation

**User mode (--user flag):**
- Lists skills in `~/.claude/plugins` and `~/.claude/skills`
- Shows user-installed skills
- Permissive filename validation

**Path mode (explicit path):**
- Lists skills at specific path
- Strict filename validation

**Arguments:**
- `[path]` - Path to list skills from (default: current directory)

**Options:**
- `--user` - List user-installed skills in ~/.claude
- `--verbose` - Show detailed information (full paths, warnings)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - List operation successful (warnings don't fail)
- `2` - System error (directory not found, config invalid)

**Validation Status:**
- ✅ `valid` - Filename is "SKILL.md" (uppercase)
- ⚠️ `warning` - Non-standard filename detected (skill.md, Skill.md, etc.)

**Output Format:**
```yaml
status: success
context: project | user
skillsFound: 3
skills:
  - name: skill1
    path: resources/skills/SKILL.md
    validation: valid
  - name: skill2
    path: skills/skill2.md
    validation: warning
    warning: Non-standard filename (should be SKILL.md)
```

**Examples:**
```bash
# List project skills (default)
vat skills list

# List user-installed skills
vat skills list --user

# List skills at specific path
vat skills list packages/my-agent

# Show detailed information
vat skills list --verbose
```

---

## Distribution Workflow

The complete workflow for creating and distributing Claude Code skills:

### 1. Development
- Create `SKILL.md` with frontmatter
- Add resources and linked markdown files
- Test locally with Claude Code

### 2. Validation
```bash
# Validate skill correctness
vat skills validate resources/skills
```

### 3. Build (for npm packages)
```bash
# Add to package.json
{
  "vat": {
    "skills": [{
      "name": "my-skill",
      "source": "./resources/skills/SKILL.md",
      "path": "./dist/skills/my-skill"
    }]
  }
}

# Build during package build
bun run build  # Runs: tsc && vat skills build
```

### 4. Package (for standalone distribution)
```bash
# Create distributable ZIP
vat skills package resources/skills/SKILL.md -o dist/my-skill
```

### 5. Distribution
**Option A: npm package**
```bash
npm publish  # Skills installed via postinstall hook
```

**Option B: GitHub releases**
- Upload ZIP from step 4
- Users download and extract to `~/.claude/skills/`

**Option C: Direct install**
```bash
# From npm (--target and --scope required)
vat skills install npm:@my-org/my-skill-package --target claude --scope user

# From local ZIP
vat skills install my-skill.zip --target claude --scope user
```

### 6. Installation
Users install via:
```bash
# Manual install — both --target and --scope are required
vat skills install npm:@my-org/my-skill-package --target claude --scope user
vat skills install ./my-skill.zip --target claude --scope user

# Install to Cursor instead
vat skills install npm:@my-org/my-skill-package --target cursor --scope user

# Dry-run to preview before committing
vat skills install ./my-skill.zip --target claude --scope user --dry-run
```

### 7. Usage
```
# In Claude Code
User: /my-skill
# Skill executes
```

---

## When to Use Which Install Command

| Use case | Command |
|----------|---------|
| Install a SKILL.md-based skill (local dir, ZIP, .tgz, npm package) to any of 7 supported platforms | `vat skills install <source> --target <target> --scope <scope>` |
| Install a Claude plugin (`.claude-plugin/`, `plugin.json`, marketplace structure) | `vat claude plugin install <source>` |
| Upload a skill to your Anthropic org for Claude.ai (org admin only, requires ANTHROPIC_API_KEY) | `vat claude org skills install <source>` or `vat claude org skills install --from-npm <package>` |

**Key distinctions:**
- `vat skills install` — file-based, multi-platform, works entirely offline (except npm sources). Installs to local agent directories.
- `vat claude plugin install` — Claude-specific plugin format. Installs to `~/.claude/plugins/` and updates Claude's plugin registry.
- `vat claude org skills install` — cloud upload. Pushes skills to Anthropic's organization API so they are available to all org members in Claude.ai.

---

## Best Practices

### Skill Naming
- Use lowercase with hyphens: `my-skill`, not `MySkill` or `my_skill`
- Avoid reserved words: `help`, `exit`, `clear`, `history`
- No XML-like tags: `<skill>` or `</skill>`

### Skill Structure
- Always name the file exactly `SKILL.md` (uppercase)
- Include required frontmatter: `name`, `description`
- Keep descriptions under 500 characters
- Use forward slashes in paths (not backslashes)

### Distribution
- Validate before packaging: `vat skills validate`
- Test in dry-run mode first: `vat skills package --dry-run`
- Include version in frontmatter for tracking
- Document installation instructions in README

### Package Management
- Use `vat.skills` in package.json for npm distribution
- Build skills during package build: `tsc && vat skills build`
- Test installation locally before publishing
- Use semantic versioning for skill versions

### User Installation
- Always specify both `--target` and `--scope` — they are required with no defaults
- Use `--dry-run` to preview what will be installed before committing
- Use `--force` flag carefully (overwrites existing skills)
- Verify installation: `vat skills list --user`
- Remember to restart the target agent or run `/reload-skills` in Claude Code

---

## Troubleshooting

### "Invalid target" / "Invalid scope"
**Problem:** `--target` or `--scope` value is not recognized.

**Solution:** Use one of the exact values listed in the Targets table. Both flags are required.

Valid targets: `claude`, `codex`, `copilot`, `gemini`, `cursor`, `windsurf`, `agents`
Valid scopes: `user`, `project`

```bash
# Correct
vat skills install ./my-skill --target claude --scope user
```

### "Skill validation failed during install"
**Problem:** The skill's `SKILL.md` has validation errors. No files were written.

**Solution:** Fix the errors reported, then retry. Run validate first to see all issues:
```bash
vat skills validate ./my-skill
vat skills install ./my-skill --target claude --scope user
```

### "Already installed" (conflict without --force)
**Problem:** A skill with the same name already exists at the install path.

**Solution:** Use `--force` to overwrite, or use `-n/--name` to install under a different name:
```bash
vat skills install my-skill.zip --target claude --scope user --force
# or install under a different name
vat skills install my-skill.zip --target claude --scope user --name my-skill-v2
```

### "No skills found in package.json"
**Problem:** Running `vat skills build` without `vat.skills` field

**Solution:** Add `vat.skills` to package.json:
```json
{
  "vat": {
    "skills": [...]
  }
}
```

### "Skill source not found"
**Problem:** `source` path in package.json is incorrect

**Solution:** Verify path is relative to package.json:
```json
{
  "vat": {
    "skills": [{
      "source": "./resources/skills/SKILL.md"  // Must exist
    }]
  }
}
```

### "Reserved word in name"
**Problem:** Skill name uses reserved word like "help" or "exit"

**Solution:** Choose different name:
```yaml
---
name: my-help  # Instead of "help"
---
```

### "Skill not recognized by Claude Code"
**Problem:** Installed skill doesn't appear in Claude Code

**Solution:**
1. Verify installation: `vat skills list --user`
2. Check location: Should be in `~/.claude/skills/` not `~/.claude/plugins/`
3. Restart Claude Code or run `/reload-skills`

### "Windows-style backslashes"
**Problem:** Links use backslashes: `resources\SKILL.md`

**Solution:** Use forward slashes: `resources/SKILL.md`

---

## Related Commands

- `vat audit` - Comprehensive validation for plugins, marketplaces, and skills
- `vat resources validate` - Validate markdown resources (links, anchors)
- `vat doctor` - Check environment and installation health

---

## See Also

- [CLI Reference](./index.md) - Complete CLI documentation
- [Audit Command](./audit.md) - Comprehensive validation
- [Resources Command](./resources.md) - Markdown resource validation
