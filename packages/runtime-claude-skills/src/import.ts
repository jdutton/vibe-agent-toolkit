import * as fs from 'node:fs';
import * as path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { parseFrontmatter } from './parsers/frontmatter-parser.js';
import { ClaudeSkillFrontmatterSchema, VATClaudeSkillFrontmatterSchema } from './schemas/claude-skill-frontmatter.js';

export interface ImportOptions {
  /**
   * Path to SKILL.md file to import
   */
  skillPath: string;

  /**
   * Optional custom output path for agent.yaml
   * If not specified, will place agent.yaml in same directory as SKILL.md
   */
  outputPath?: string;

  /**
   * Force overwrite if agent.yaml already exists
   * Default: false
   */
  force?: boolean;
}

export interface ImportSuccess {
  success: true;
  agentPath: string;
}

export interface ImportError {
  success: false;
  error: string;
}

export type ImportResult = ImportSuccess | ImportError;

/**
 * Import a Claude Skill (SKILL.md) and convert to VAT agent format (agent.yaml)
 *
 * @param options - Import options
 * @returns Result with agent.yaml path or error
 */
export async function importSkillToAgent(options: ImportOptions): Promise<ImportResult> {
  const { skillPath, outputPath, force = false } = options;

  // Check if SKILL.md exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillPath is user input but validated
  if (!fs.existsSync(skillPath)) {
    return {
      success: false,
      error: `SKILL.md does not exist: ${skillPath}`,
    };
  }

  // Read SKILL.md content
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated above
  const content = fs.readFileSync(skillPath, 'utf-8');

  // Parse frontmatter
  const parseResult = parseFrontmatter(content);

  if (!parseResult.success) {
    return {
      success: false,
      error: `Failed to parse frontmatter: ${parseResult.error}`,
    };
  }

  const { frontmatter } = parseResult;

  // Try VAT schema first (allows more flexible metadata), fall back to strict schema
  const vatValidationResult = VATClaudeSkillFrontmatterSchema.safeParse(frontmatter);
  const strictValidationResult = ClaudeSkillFrontmatterSchema.safeParse(frontmatter);

  if (!vatValidationResult.success && !strictValidationResult.success) {
    // Neither schema validates - report error
    const firstError = strictValidationResult.error.errors[0];
    const errorMessage = firstError
      ? `${firstError.path.join('.')}: ${firstError.message}`
      : 'Unknown validation error';

    return {
      success: false,
      error: `Invalid SKILL.md frontmatter - ${errorMessage}`,
    };
  }

  // Determine output path
  const agentPath = outputPath ?? path.join(path.dirname(skillPath), 'agent.yaml');

  // Check if output already exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from validated skillPath
  if (fs.existsSync(agentPath) && !force) {
    return {
      success: false,
      error: `agent.yaml already exists at ${agentPath}. Use --force to overwrite.`,
    };
  }

  // Build agent.yaml structure
  const agentManifest = buildAgentManifest(frontmatter);

  // Write agent.yaml
  try {
    const yamlContent = stringifyYaml(agentManifest, {
      indent: 2,
      lineWidth: 100,
    });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from validated skillPath
    fs.writeFileSync(agentPath, yamlContent, 'utf-8');

    return {
      success: true,
      agentPath,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to write agent.yaml: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Build agent.yaml manifest structure from Claude Skill frontmatter
 *
 * @param frontmatter - Validated Claude Skill frontmatter
 * @returns Agent manifest object
 */
function buildAgentManifest(frontmatter: Record<string, unknown>): Record<string, unknown> {
  // Extract core fields
  const name = frontmatter['name'] as string;
  const description = frontmatter['description'] as string;

  // Extract optional fields
  const license = frontmatter['license'] as string | undefined;
  const compatibility = frontmatter['compatibility'] as string | undefined;
  const metadata = frontmatter['metadata'] as Record<string, unknown> | undefined;

  // Extract version from metadata or use default
  const version = (metadata?.['version'] as string) ?? '0.1.0';

  // Build agent metadata
  const agentMetadata: Record<string, unknown> = {
    name,
    description,
    version,
  };

  // Add optional license if present
  if (license) {
    agentMetadata['license'] = license;
  }

  // Add tags from metadata if present
  if (metadata?.['tags']) {
    agentMetadata['tags'] = metadata['tags'];
  }

  // Build agent manifest
  const agentManifest: Record<string, unknown> = {
    metadata: agentMetadata,
    spec: {
      runtime: 'claude-skills',
    },
  };

  // Add compatibility as a comment/note in spec if present
  if (compatibility) {
    // Store compatibility in spec for reference
    (agentManifest['spec'] as Record<string, unknown>)['compatibility'] = compatibility;
  }

  return agentManifest;
}
