# Collection Validation Test Fixtures

Comprehensive test fixtures for validating collection-based resource validation with frontmatter schemas.

## Structure

```
collections/
├── schemas/                    # JSON Schemas for validation
│   ├── skill-frontmatter.json  # Schema for SKILL.md files
│   ├── strict-guide.json       # Strict validation (no extra fields)
│   └── permissive-doc.json     # Permissive (extra fields allowed)
├── valid/                      # Resources with valid frontmatter
│   ├── guide-valid.md          # Valid guide
│   └── doc-valid.md            # Valid doc
├── invalid/                    # Resources with invalid frontmatter
│   ├── guide-invalid-category.md    # Wrong enum value
│   ├── guide-missing-required.md    # Missing required field
│   └── doc-invalid-status.md        # Wrong enum value
├── skills/                     # Fake SKILL.md files
│   ├── code-reviewer-SKILL.md       # Valid skill
│   ├── badName-SKILL.md             # Invalid: wrong name pattern
│   ├── missing-description-SKILL.md # Invalid: missing required field
│   ├── short-description-SKILL.md   # Invalid: description too short
│   └── invalid-version-SKILL.md     # Invalid: wrong version format
├── vibe-agent-toolkit.config.yaml   # Test config with collections
└── README.md                   # This file
```

## Usage

### Running Validation

From the test fixture directory:

```bash
# Validate all collections (should find 7 errors)
vat resources validate . --config vibe-agent-toolkit.config.yaml

# Validate specific collection
vat resources validate . --config vibe-agent-toolkit.config.yaml --collection guides
vat resources validate . --config vibe-agent-toolkit.config.yaml --collection documentation
vat resources validate . --config vibe-agent-toolkit.config.yaml --collection skills
```

### Expected Results

**Valid files (2):**
- `valid/guide-valid.md` - ✅ Passes strict validation
- `valid/doc-valid.md` - ✅ Passes permissive validation

**Invalid files (7 errors):**
- `invalid/guide-invalid-category.md` - ❌ category: invalid enum value
- `invalid/guide-missing-required.md` - ❌ Missing required field "title"
- `invalid/doc-invalid-status.md` - ❌ status: invalid enum value
- `skills/badName-SKILL.md` - ❌ name: pattern mismatch (not kebab-case)
- `skills/missing-description-SKILL.md` - ❌ Missing required field "description"
- `skills/short-description-SKILL.md` - ❌ description: too short (< 10 chars)
- `skills/invalid-version-SKILL.md` - ❌ version: pattern mismatch (not semver)

## Schemas

### skill-frontmatter.json

Required fields for SKILL.md files:
- `name` (string, kebab-case pattern)
- `description` (string, minLength: 10)

Optional fields:
- `version` (semantic version pattern)
- `model` (enum: claude-sonnet-4-5, claude-opus-4-5, claude-haiku-4)
- `tools` (array of strings)
- `permissions` (object)

Validation mode: **permissive** (extra fields allowed)

### strict-guide.json

Required fields:
- `title` (string, minLength: 1)
- `category` (enum: tutorial, guide, reference, howto)

Optional fields:
- `tags` (array of strings)

Validation mode: **strict** (no extra fields allowed)

### permissive-doc.json

All fields optional:
- `title` (string)
- `status` (enum: draft, review, published, archived)
- `author` (string)

Validation mode: **permissive** (extra fields allowed)

## Testing Scenarios

### 1. Strict vs Permissive Mode

```bash
# Strict: extra fields rejected
vat resources validate . --collection guides

# Permissive: extra fields allowed
vat resources validate . --collection documentation
```

### 2. Enum Validation

Test files with invalid enum values:
- `guide-invalid-category.md` - category not in enum
- `doc-invalid-status.md` - status not in enum

### 3. Required Field Validation

Test files missing required fields:
- `guide-missing-required.md` - missing "title"
- `missing-description-SKILL.md` - missing "description"

### 4. Pattern Validation

Test files with pattern mismatches:
- `badName-SKILL.md` - name not kebab-case
- `invalid-version-SKILL.md` - version not semver

### 5. String Length Validation

Test files with length violations:
- `short-description-SKILL.md` - description < 10 chars

## Integration with Tests

Use these fixtures in system tests:

```typescript
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { loadProjectConfig } from '@vibe-agent-toolkit/agent-config';
import path from 'node:path';

// Load test fixtures
const fixturesDir = path.join(__dirname, '../test-fixtures/collections');
const config = await loadProjectConfig(fixturesDir);

// Create registry with config
const registry = new ResourceRegistry({ config, rootDir: fixturesDir });

// Crawl and validate
await registry.crawl({ baseDir: fixturesDir });
const issues = await registry.validate();

// Should find 7 validation errors
expect(issues.filter(i => i.severity === 'error')).toHaveLength(7);
```

## Notes

- Test fixtures are excluded from npm package (see package.json `files` field)
- Schemas use JSON Schema draft-07
- Validation uses AJV (JSON Schema validator)
- Error messages show actual values and expected values for clarity
