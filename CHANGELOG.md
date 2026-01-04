# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Agent Runtime**: Execute agents with `vat agent run <name> "input"` using Anthropic API
- **Agent Discovery**: List all agents in your project with `vat agent list`
- **Agent Validation**: Validate manifests and resources with `vat agent validate <name>`
- **Claude Skills Audit**: Comprehensive validation of Claude Skills with `vat agent audit [path] --recursive`
  - Validates frontmatter fields (name, description, license, compatibility)
  - Enforces naming conventions (lowercase, hyphens, reserved words)
  - Checks link integrity (broken links, Windows paths)
  - Detects console-incompatible tool usage (Write, Edit, Bash)
  - Exit codes: 0 (success), 1 (validation errors), 2 (system errors)
- **Claude Skills Import**: Convert SKILL.md to agent.yaml with `vat agent import <skillPath> [options]`
  - Extracts frontmatter metadata to agent manifest
  - Validates before conversion
  - Supports custom output paths with `--output`
  - Force overwrite with `--force`
- **Claude Skills Packaging**: Build agents as Claude Skills with `vat agent build <name>`
- **Installation Management**: Install/uninstall Claude Skills locally with `vat agent install/uninstall <name>`
- **Installation Scopes**: Control installation location with `--scope user|project`
- **Dev Mode**: Symlink-based development workflow with `--dev` flag
- **Gitignore Support**: File crawler and link validator now respect `.gitignore` patterns
- **RAG System**: Document indexing and semantic search with LanceDB
- New package: `@vibe-agent-toolkit/agent-config` - agent manifest loading and validation
- New package: `@vibe-agent-toolkit/runtime-claude-skills` - Claude Skills builder, installer, validator, and import/export
- New package: `@vibe-agent-toolkit/discovery` - format detection and file scanning utilities
- New documentation: [Claude Skills Best Practices Guide](./docs/guides/claude-skills-best-practices.md)
- New documentation: [Audit Command Reference](./docs/cli/audit.md)
- New documentation: [Import Command Reference](./docs/cli/import.md)

### Changed
- Simplified agent manifest schema - removed `apiVersion` and `kind` fields
- Simplified config schema - `resources.exclude` instead of `resources.defaults.exclude`
- Link validator now warns when links point to gitignored files

## [0.1.0] - 2025-12-26

### Added
- Initial release of Vibe Agent Toolkit
- Foundation for building portable AI agents
