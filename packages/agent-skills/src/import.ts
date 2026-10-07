import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';
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
  /**
   * Which refusal this is, decided where it was raised: a SKILL.md that is not
   * there, or an agent.yaml already there without `force`, is the invocation's
   * mistake (`USAGE_INVALID`); a SKILL.md the OS will not read, or whose
   * frontmatter no Agent Skills schema accepts, is the input's
   * (`INPUT_UNREADABLE`); an agent.yaml whose directory is not there is the
   * invocation's (`USAGE_INVALID`), and any other failed write is a run that did
   * not finish (`RUN_INCOMPLETE`).
   */
  refusal: RefusalCode;
}

export type ImportResult = ImportSuccess | ImportError;

/**
 * Import an Agent Skill (SKILL.md) and convert to VAT agent format (agent.yaml)
 *
 * @param options - Import options
 * @returns Result with agent.yaml path or error
 */
export function importSkillToAgent(options: ImportOptions): ImportResult {
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

  // An entry already there — a dangling link included — is not overwritten
  // without `force`; one the OS will not let VAT probe is not assumed absent.
  if (!force) {
    const existing = existingOutputRefusal(agentPath);
    if (existing !== undefined) return existing;
  }

  // Build agent.yaml structure
  const agentManifest = buildAgentManifest(frontmatter);

  // Serialized outside the write's catch: a throw here is a defect in VAT, not a refused write.
  const yamlContent = stringifyYaml(agentManifest, { indent: 2, lineWidth: 100 });

  try {
    fs.writeFileSync(agentPath, yamlContent, 'utf-8');
  } catch (error) {
    return writeRefusal(agentPath, error);
  }
  return { success: true, agentPath };
}

/**
 * A refused agent.yaml write, classified by errno: an output directory that is
 * not there is the invocation's mistake (`--output` names it); anything else
 * the OS says is a write that did not finish.
 */
function writeRefusal(agentPath: string, error: unknown): ImportError {
  const reason = error instanceof Error ? error.message : String(error);
  if (isPathAbsentError(error)) {
    return { success: false, error: `Cannot write agent.yaml: the directory of ${agentPath} does not exist (${reason})`, refusal: 'USAGE_INVALID' };
  }
  return { success: false, error: `Failed to write agent.yaml: ${reason}`, refusal: 'RUN_INCOMPLETE' };
}

/**
 * Why `agentPath` must not be written without `force`, or `undefined` when
 * nothing is there. `lstat`, so a dangling link counts as there.
 */
function existingOutputRefusal(agentPath: string): ImportError | undefined {
  try {
    fs.lstatSync(agentPath);
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    return { success: false, error: `Cannot tell whether agent.yaml exists (${code}): ${agentPath}`, refusal: 'INPUT_UNREADABLE' };
  }
  return { success: false, error: `agent.yaml already exists at ${agentPath}. Use --force to overwrite.`, refusal: 'USAGE_INVALID' };
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
