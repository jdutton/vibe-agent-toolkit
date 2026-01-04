# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Agent Runtime**: Execute agents with `vat agent run <name> "input"` using Anthropic API
- **Agent Discovery**: List all agents in your project with `vat agent list`
- **Agent Validation**: Validate manifests and resources with `vat agent validate <name>`
- **Claude Skills Audit**: Audit Claude Skills for quality and console compatibility with `vat agent audit [path] --recursive`
- **Claude Skills Packaging**: Build agents as Claude Skills with `vat agent build <name>`
- **Installation Management**: Install/uninstall Claude Skills locally with `vat agent install/uninstall <name>`
- **Installation Scopes**: Control installation location with `--scope user|project`
- **Dev Mode**: Symlink-based development workflow with `--dev` flag
- **Gitignore Support**: File crawler and link validator now respect `.gitignore` patterns
- **RAG System**: Document indexing and semantic search with LanceDB
- New package: `@vibe-agent-toolkit/agent-config` - agent manifest loading and validation
- New package: `@vibe-agent-toolkit/runtime-claude-skills` - Claude Skills builder, installer, and validator
- New package: `@vibe-agent-toolkit/discovery` - format detection and file scanning utilities

### Changed
- Simplified agent manifest schema - removed `apiVersion` and `kind` fields
- Simplified config schema - `resources.exclude` instead of `resources.defaults.exclude`
- Link validator now warns when links point to gitignored files

## [0.1.0] - 2025-12-26

### Added
- Initial release of Vibe Agent Toolkit
- Foundation for building portable AI agents
