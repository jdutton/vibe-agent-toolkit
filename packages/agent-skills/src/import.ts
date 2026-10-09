import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { applyTreePlan, isPathAbsentError, planTreeChanges, safePath } from '@vibe-agent-toolkit/utils';
import { stringify as stringifyYaml } from 'yaml';

import { parseFrontmatter } from './parsers/frontmatter-parser.js';
import { AgentSkillFrontmatterSchema, VATAgentSkillFrontmatterSchema } from './schemas/agent-skill-frontmatter.js';

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
   * Replace whatever is at the output (`--force`). Default `false`: anything there but an
   * empty directory is refused (`TREE_DEST_OCCUPIED`, thrown by the plan before anything
   * is written) and left as it was.
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
  /**
   * Which refusal this is, decided where it was raised: a SKILL.md that is not
   * there is the invocation's mistake (`USAGE_INVALID`); a SKILL.md the OS will
   * not read, or whose frontmatter no Agent Skills schema accepts, is the
   * input's (`INPUT_UNREADABLE`). What the write's plan refuses is not an
   * `ImportError`: it is thrown — an agent.yaml already there without `force`
   * as `TREE_DEST_OCCUPIED`, a destination the OS will not examine or write as
   * a classified `destination` fault (`FsFaultError`, `RUN_INCOMPLETE`).
   */
  refusal: RefusalCode;
}

export type ImportResult = ImportSuccess | ImportError;

/**
 * Import an Agent Skill (SKILL.md) and convert to VAT agent format (agent.yaml)
 *
 * The agent.yaml is written by ONE tree-change plan (`replace-file`): a new file beside
 * it, renamed into place, so a refused write never leaves a truncated agent.yaml, and
 * the directory it goes in is made when absent.
 *
 * @param options - Import options
 * @returns Result with agent.yaml path or error
 * @throws VatError `TREE_DEST_OCCUPIED` when something is at the output and `force` is not set
 * @throws {FsFaultError} A `destination` fault, when the OS refuses to examine or write the output
 */
export async function importSkillToAgent(options: ImportOptions): Promise<ImportResult> {
  const { skillPath, outputPath, force = false } = options;

  // Read SKILL.md — only an ABSENCE is "does not exist"; anything else the OS
  // says (a directory, EACCES) is an input that is there and cannot be read.
  let content: string;
  try {
    content = fs.readFileSync(skillPath, 'utf-8');
  } catch (error) {
    if (isPathAbsentError(error)) {
      return { success: false, error: `SKILL.md does not exist: ${skillPath}`, refusal: 'USAGE_INVALID' };
    }
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    return { success: false, error: `SKILL.md cannot be read (${code}): ${skillPath}`, refusal: 'INPUT_UNREADABLE' };
  }

  // Parse frontmatter
  const parseResult = parseFrontmatter(content);

  if (!parseResult.success) {
    return {
      success: false,
      error: `Failed to parse frontmatter: ${parseResult.error}`,
      refusal: 'INPUT_UNREADABLE',
    };
  }

  const { frontmatter } = parseResult;

  // Try VAT schema first (allows more flexible metadata), fall back to strict schema
  const vatValidationResult = VATAgentSkillFrontmatterSchema.safeParse(frontmatter);
  const strictValidationResult = AgentSkillFrontmatterSchema.safeParse(frontmatter);

  if (!vatValidationResult.success && !strictValidationResult.success) {
    // Neither schema validates - report error
    const firstError = strictValidationResult.error.errors[0];
    const errorMessage = firstError
      ? `${firstError.path.join('.')}: ${firstError.message}`
      : 'Unknown validation error';

    return {
      success: false,
      error: `Invalid SKILL.md frontmatter - ${errorMessage}`,
      refusal: 'INPUT_UNREADABLE',
    };
  }

  // Determine output path
  const agentPath = outputPath ?? safePath.join(path.dirname(skillPath), 'agent.yaml');

  // Build agent.yaml structure
  const agentManifest = buildAgentManifest(frontmatter);

  // Serialized before the plan: a throw here is a defect in VAT, not a refused write.
  const yamlContent = stringifyYaml(agentManifest, { indent: 2, lineWidth: 100 });

  // An entry already there — a dangling link included — is not replaced without `force`; one
  // the OS will not let VAT examine is the destination's fault, never assumed absent.
  const plan = await planTreeChanges([{
    op: 'replace-file',
    dest: agentPath,
    ownership: force ? { kind: 'force' } : { kind: 'must-be-free' },
    contents: yamlContent,
    label: 'agent.yaml',
  }]);
  await applyTreePlan(plan);
  return { success: true, agentPath };
}

/**
 * Build agent.yaml manifest structure from Agent Skill frontmatter
 *
 * @param frontmatter - Validated Agent Skill frontmatter
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
      runtime: 'agent-skills',
    },
  };

  // Add compatibility as a comment/note in spec if present
  if (compatibility) {
    // Store compatibility in spec for reference
    (agentManifest['spec'] as Record<string, unknown>)['compatibility'] = compatibility;
  }

  return agentManifest;
}
