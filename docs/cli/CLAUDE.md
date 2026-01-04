# vat CLI: Agent Guidance

## When to Use Commands

**`vat resources validate docs/`** - Before committing markdown changes. Exit 0 = safe, 1 = broken links.

**`vat resources scan .`** - Get markdown stats. Outputs YAML to stdout.

**`vat agent build ./path`** - Bundle agent for deployment. Creates `dist/vat-bundles/{target}/`.

**`vat agent run ./path`** - Test agent locally before deployment.

**`vat rag index docs/`** - Create vector embeddings for semantic search.

**`vat rag search "query"`** - Query indexed docs semantically (not keywords).

## Exit Codes

- `0` - Success
- `1` - Validation/build failures (fix and retry)
- `2` - System errors (config/environment issues)

## Context Detection

Wrapper auto-detects where it runs:
- **Dev mode**: In vibe-agent-toolkit repo → shows `-dev` suffix
- **Local**: In node_modules → uses project version
- **Global**: Fallback → uses global install

Run `VAT_DEBUG=1 vat --version` to see detection details.

## Output Patterns

**Structured (stdout)**: YAML from scan/validate - parse with `yq` or YAML parser

**Errors (stderr)**: Format `file:line:col: severity: message` - parseable for test output

## Common Patterns

```bash
# Validate before commit
vat resources validate docs/ && git commit -m "docs"

# Build and test agent
vat agent build ./my-agent
vat agent run ./my-agent --input "test"

# Setup semantic search
vat rag index docs/
vat rag search "topic"
```

## Configuration

Optional `vibe-agent-toolkit.config.yaml` at project root:

```yaml
version: 1
resources:
  include: ["docs/**/*.md"]
  exclude: ["node_modules/**"]
```

## Key Points

- Validation only checks **internal** links (not external URLs - avoids flaky network)
- Always check exit codes in scripts
- Use explicit paths when possible: `vat resources validate docs/`
- Enable debug for context issues: `VAT_DEBUG=1`

## Help

- Quick: `vat --help`
- Detailed: `vat --help --verbose`
- Command-specific: `vat resources --help`
