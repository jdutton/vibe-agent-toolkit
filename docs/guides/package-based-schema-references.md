---
title: Package-Based Schema References
description: How to reference JSON schemas from installed npm packages
tags: [schemas, validation, configuration]
---

# Package-Based Schema References

The `vat resources validate` command supports referencing JSON schemas from installed npm packages, not just local files. This allows you to use schemas exported by packages like `@vibe-agent-toolkit/agent-skills` without copying them to your project.

## Quick Start

```yaml
# vibe-agent-toolkit.config.yaml
version: 1
resources:
  collections:
    skills:
      include: ["docs/skills/**/*.md"]
      validation:
        frontmatterSchema: "@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json"
```

Or via CLI:
```bash
vat resources validate docs/skills/ \
  --frontmatter-schema "@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json"
```

## Path Resolution Rules

The schema path resolver uses Node.js-style module resolution with these rules:

### 1. Absolute Paths → Used As-Is

```yaml
frontmatterSchema: "/Users/jeff/project/schemas/custom.json"
```

Always treated as file paths. No package resolution attempted.

### 2. Explicit Relative Paths → Used As-Is

```yaml
frontmatterSchema: "./schemas/custom-schema.json"    # Relative to CWD
frontmatterSchema: "../shared/schema.json"            # Parent directory
```

Paths starting with `./` or `../` are always treated as file paths.

**Best practice**: Use explicit `./` for local files to avoid ambiguity.

### 3. Scoped Package Paths → Package Resolution

```yaml
frontmatterSchema: "@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json"
```

Paths starting with `@` are **always** resolved as scoped npm packages.

**Requirements**:
- Package must be installed (`npm install @vibe-agent-toolkit/agent-skills`)
- Subpath must be exported in package's `package.json` exports field
- Throws clear error if package not found or subpath not exported

### 4. Bare Specifiers → Try Package, Fallback to File

```yaml
frontmatterSchema: "schemas/file.json"              # Could be package or file
frontmatterSchema: "lodash/schemas/validation.json"  # Could be package or file
```

For paths without `@`, `./`, `../`, or `/` prefix:

1. **Try package resolution first** - Checks if it matches an installed package
2. **Fallback to file** - If no matching package, treats as relative file path

**When collision occurs**:
- Only if a package with matching name is installed
- AND the subpath is exported in that package

Example collision:
```
# If package "schemas" is installed and exports subpaths:
frontmatterSchema: "schemas/file.json"    # → Package "schemas"

# To force file resolution:
frontmatterSchema: "./schemas/file.json"  # → File (explicit)
```

## How It Works

### Under the Hood

The resolver uses Node.js's `import.meta.resolve()`:

```typescript
// Resolves package paths using Node's module system
const resolved = import.meta.resolve(
  '@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json'
);
// Returns: file:///path/to/node_modules/@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json
```

This means:
- ✅ Works in development (monorepo)
- ✅ Works in production (npm install)
- ✅ Works anywhere Node.js + the package is installed
- ✅ Respects `package.json` "exports" field
- ✅ Respects version installed in your `node_modules/`

### Package Exports

For a package to support schema references, it must export the schemas in `package.json`:

```json
{
  "name": "@vibe-agent-toolkit/agent-skills",
  "exports": {
    ".": "./dist/index.js",
    "./schemas/*": "./schemas/*"
  },
  "files": [
    "dist",
    "schemas/"
  ]
}
```

This configuration:
- Exposes all files in `schemas/` directory
- Includes them in the npm package
- Allows them to be resolved via import.meta.resolve()

## Version Management

**Question**: How do I specify which version of a package schema to use?

**Answer**: Versioning is handled by npm, not the schema path.

The version is determined by:
1. Your `package.json` dependencies: `"@vibe-agent-toolkit/agent-skills": "^0.1.3"`
2. What's installed in `node_modules/`

There's **no syntax** for version in the path itself:
```
❌ @vibe-agent-toolkit/agent-skills@1.0.0/schemas/file.json
✅ @vibe-agent-toolkit/agent-skills/schemas/file.json
```

To use a different version:
```bash
# Install specific version
npm install @vibe-agent-toolkit/agent-skills@0.2.0

# Or update package.json
{
  "dependencies": {
    "@vibe-agent-toolkit/agent-skills": "^0.2.0"
  }
}
```

## Best Practices

### For Package References

```yaml
# ✅ GOOD: Scoped package with full path
frontmatterSchema: "@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json"

# ⚠️ AVOID: Unscoped package (less clear)
frontmatterSchema: "some-package/schemas/file.json"
```

**Why**: Scoped packages (`@scope/name`) are unambiguous and throw clear errors if not found.

### For File References

```yaml
# ✅ GOOD: Explicit relative path
frontmatterSchema: "./schemas/custom-schema.json"

# ✅ GOOD: Absolute path
frontmatterSchema: "/absolute/path/schema.json"

# ⚠️ AVOID: Bare specifier (ambiguous)
frontmatterSchema: "schemas/custom-schema.json"
```

**Why**: Explicit `./` removes all ambiguity about whether it's a package or file.

### Combined Example

```yaml
# vibe-agent-toolkit.config.yaml
version: 1
resources:
  collections:
    # Skills using package-provided schema
    skills:
      include: ["docs/skills/**/*.md"]
      validation:
        frontmatterSchema: "@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json"

    # Custom docs using local schema
    documentation:
      include: ["docs/**/*.md"]
      exclude: ["docs/skills/**"]
      validation:
        frontmatterSchema: "./schemas/doc-frontmatter.json"

    # Guides using absolute path schema
    guides:
      include: ["guides/**/*.md"]
      validation:
        frontmatterSchema: "/shared/schemas/guide-schema.json"
```

## Troubleshooting

### Package Not Found

```
Error: Cannot resolve package path: @scope/package/schemas/file.json
Possible causes:
  - Package not installed
  - Subpath not exported in package.json
  - Typo in package name or path
```

**Solutions**:
1. Install the package: `npm install @scope/package`
2. Check the package exports the subpath (look at package.json)
3. Verify you're using the correct path (check package README)

### Subpath Not Exported

```
Error: Cannot resolve package path: @vibe-agent-toolkit/agent-skills/internal/private.json
```

**Cause**: The package exists but doesn't export `internal/private.json`.

**Solution**: Use only paths that the package explicitly exports. Check the package documentation.

### Ambiguous Bare Specifier

If you have both:
- A package named `utils`
- A directory `./utils/`

Then `utils/schema.json` is ambiguous.

**Solution**: Use explicit `./`:
```yaml
frontmatterSchema: "./utils/schema.json"  # Forces file resolution
```

## Examples

### Using Agent Skills Schema

```bash
# Install the package
npm install @vibe-agent-toolkit/agent-skills

# Reference in config
cat > vibe-agent-toolkit.config.yaml <<EOF
version: 1
resources:
  collections:
    skills:
      include: ["docs/skills/**/*.md"]
      validation:
        frontmatterSchema: "@vibe-agent-toolkit/agent-skills/schemas/skill-frontmatter.json"
EOF

# Validate
vat resources validate docs/skills/
```

### Using Local Schema

```bash
# Create schema
mkdir -p schemas
cat > schemas/custom.json <<EOF
{
  "type": "object",
  "required": ["title"],
  "properties": {
    "title": { "type": "string" },
    "author": { "type": "string" }
  }
}
EOF

# Reference in config
cat > vibe-agent-toolkit.config.yaml <<EOF
version: 1
resources:
  collections:
    docs:
      include: ["docs/**/*.md"]
      validation:
        frontmatterSchema: "./schemas/custom.json"
EOF

# Validate
vat resources validate docs/
```

## Related

- [Agent Skills Package](../../packages/agent-skills/README.md) - Exported schemas
- [Resources Validation](../cli/validate.md) - Full validation documentation
- [Configuration](../configuration.md) - Config file reference
