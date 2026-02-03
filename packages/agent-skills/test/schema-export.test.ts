/**
 * Tests for exported JSON schemas
 *
 * Validates that the exported schemas can be used by external tools
 * and correctly validate SKILL.md frontmatter.
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// Test files need to read fixtures dynamically

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv, { type ValidateFunction } from 'ajv';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCHEMAS_DIR = join(__dirname, '..', 'schemas');
const FIXTURES_DIR = join(__dirname, 'fixtures', 'schema-validation');

const SKILL_FRONTMATTER_SCHEMA = 'skill-frontmatter';
const VAT_SKILL_FRONTMATTER_SCHEMA = 'vat-skill-frontmatter';
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---/;

/** Load and parse a JSON schema file */
function loadSchema(schemaName: string) {
  const schemaPath = join(SCHEMAS_DIR, `${schemaName}.json`);
  expect(existsSync(schemaPath)).toBe(true);
  return JSON.parse(readFileSync(schemaPath, 'utf-8'));
}

/** Compile a schema with AJV for validation */
function compileSchema(schemaName: string, ajv: Ajv): ValidateFunction {
  const schema = loadSchema(schemaName);
  return ajv.compile(schema);
}

/** Extract and parse YAML frontmatter from a markdown file */
function extractFrontmatter(filePath: string) {
  const content = readFileSync(filePath, 'utf-8');
  const match = FRONTMATTER_PATTERN.exec(content);
  expect(match).toBeTruthy();
  return parseYaml(match?.[1] ?? '');
}

describe('Schema Export', () => {
  it('should generate skill-frontmatter.json schema', () => {
    const schema = loadSchema(SKILL_FRONTMATTER_SCHEMA);
    expect(schema).toHaveProperty('$ref');
    expect(schema).toHaveProperty('definitions');
    expect(schema.definitions).toHaveProperty(SKILL_FRONTMATTER_SCHEMA);

    const skillSchema = schema.definitions[SKILL_FRONTMATTER_SCHEMA];
    expect(skillSchema).toHaveProperty('type', 'object');
    expect(skillSchema.properties).toHaveProperty('name');
    expect(skillSchema.properties).toHaveProperty('description');
  });

  it('should generate vat-skill-frontmatter.json schema', () => {
    const schema = loadSchema(VAT_SKILL_FRONTMATTER_SCHEMA);
    expect(schema).toHaveProperty('$ref');
    expect(schema).toHaveProperty('definitions');
    expect(schema.definitions).toHaveProperty(VAT_SKILL_FRONTMATTER_SCHEMA);

    const skillSchema = schema.definitions[VAT_SKILL_FRONTMATTER_SCHEMA];
    expect(skillSchema).toHaveProperty('type', 'object');
    expect(skillSchema.properties).toHaveProperty('metadata');
  });

  describe('Frontmatter Validation with Exported Schema', () => {
    const ajv = new Ajv({ strict: false });

    it('should validate correct frontmatter using exported schema', () => {
      const validate = compileSchema(SKILL_FRONTMATTER_SCHEMA, ajv);
      const frontmatter = extractFrontmatter(join(FIXTURES_DIR, 'valid-skill.md'));
      const valid = validate(frontmatter);

      if (!valid) {
        console.error('Validation errors:', validate.errors);
      }

      expect(valid).toBe(true);
    });

    it('should reject invalid frontmatter using exported schema', () => {
      const validate = compileSchema(SKILL_FRONTMATTER_SCHEMA, ajv);
      const frontmatter = extractFrontmatter(join(FIXTURES_DIR, 'invalid-skill.md'));
      const valid = validate(frontmatter);

      expect(valid).toBe(false);
      expect(validate.errors).toBeTruthy();

      // Should have validation errors (could be pattern, additional properties, etc.)
      const errorMessages = (validate.errors ?? []).map((e: { message?: string }) => e.message).join(', ');
      // The invalid skill has issues with name pattern and/or unknown fields
      expect(errorMessages.length).toBeGreaterThan(0);
    });

    it('should validate VAT skill with metadata using exported schema', () => {
      const validate = compileSchema(VAT_SKILL_FRONTMATTER_SCHEMA, ajv);

      const frontmatter = {
        name: 'test-skill',
        description: 'A test skill',
        metadata: {
          version: '1.0.0',
          author: 'Test Author',
        },
      };

      const valid = validate(frontmatter);

      if (!valid) {
        console.error('Validation errors:', validate.errors);
      }

      expect(valid).toBe(true);
    });
  });

  describe('Schema Exportability', () => {
    it('should export schemas in package.json exports field', () => {
      const packageJsonPath = join(__dirname, '..', 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      expect(packageJson.exports).toHaveProperty('./schemas/*');
      expect(packageJson.exports['./schemas/*']).toBe('./schemas/*');
    });

    it('should include schemas in package files', () => {
      const packageJsonPath = join(__dirname, '..', 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      expect(packageJson.files).toContain('schemas/');
    });
  });
});
