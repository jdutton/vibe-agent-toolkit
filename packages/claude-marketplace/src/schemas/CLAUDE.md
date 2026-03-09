# Claude Settings Schema Maintenance

## Canonical Reference

**Official docs**: https://code.claude.com/docs/en/settings

**JSON Schema (VS Code)**: https://json.schemastore.org/claude-code-settings.json

These schemas model Claude Code's settings files. They MUST stay synchronized with the official documentation above.

## Periodic Review Checklist

When updating these schemas, fetch the official docs URL above and compare every documented field against the Zod schemas in this directory:

1. `settings.ts` — `SharedSettingsSchema` (all levels) and `ManagedSettingsSchema` (enterprise-only)
2. `permissions.ts` — `PermissionsConfigSchema` (permission rules and modes)
3. `sandbox-config.ts` — `SandboxConfigSchema` (bash isolation, filesystem, network)
4. `auth-config.ts` — `ClaudeAuthConfigSchema` (auth helpers, login enforcement)
5. `hooks-config.ts` — `HooksConfigSchema` (lifecycle hooks)
6. `mcp-policy-config.ts` — `McpServerPolicySchema` (MCP server allow/deny)

**Look for**: new fields, removed fields, changed enum values, renamed fields, restructured nesting.

## Design Rules

- All schemas use `.passthrough()` — Postel's Law (liberal reading of external files)
- New fields should be `optional()` — settings files may omit any field
- Enum values must match the docs exactly — typos cause silent validation failures
- Managed-only fields go in `ManagedSettingsSchema.extend()`, not in `SharedSettingsSchema`
- Fields shared across all levels go in `SharedSettingsSchema`

## Last Synced

**Date**: 2026-03-09
**Source**: https://code.claude.com/docs/en/settings
