import fs from 'node:fs/promises';
import path from 'node:path';

import { AgentManifestSchema, summarizeIssues, type SeverityCounts, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { isPathAbsentError, issueLocation, safePath } from '@vibe-agent-toolkit/utils';

import { AGENT_MANIFEST_INVALID_CODE, readAgentManifestDocument, type LoadedAgentManifest } from '../loader/manifest-loader.js';

/**
 * What {@link validateAgent} found about ONE manifest it read; `status` and
 * `summary` come from `summarizeIssues`, as every library result's do.
 */
export interface ValidationResult {
  status: 'ok' | 'findings';
  summary: SeverityCounts;
  /** Each located at the manifest, relative to `locationRoot`. */
  issues: ValidationIssue[];
  /** `name`/`version` are `null` when the manifest does not say (or does not validate); `path` is absolute. */
  manifest: { name: string | null; version: string | null; path: string };
}

export interface ValidateAgentOptions {
  /** The directory every issue `location` is relative to. */
  locationRoot: string;
}

interface IssueSink {
  readonly issues: ValidationIssue[];
  readonly location: string;
}

function report(sink: IssueSink, issue: Pick<ValidationIssue, 'code' | 'severity' | 'message'>): void {
  sink.issues.push({ ...issue, location: sink.location });
}

/**
 * Validate agent manifest and check prerequisites: schema (one
 * `AGENT_MANIFEST_INVALID` per violation), RAG database, resource and prompt files.
 *
 * @throws VatError `AGENT_MANIFEST_NOT_FOUND` / `AGENT_MANIFEST_UNREADABLE` —
 *   no manifest was read, so there is nothing to report findings about
 */
export async function validateAgent(pathArg: string, options: ValidateAgentOptions): Promise<ValidationResult> {
  const { manifestPath, data } = await readAgentManifestDocument(pathArg);
  const sink: IssueSink = { issues: [], location: issueLocation(manifestPath, options.locationRoot) };

  const parsed = AgentManifestSchema.safeParse(data);
  if (!parsed.success) {
    for (const violation of parsed.error.errors) {
      const field = violation.path.join('.');
      sink.issues.push({
        code: AGENT_MANIFEST_INVALID_CODE,
        severity: 'error',
        message: field === '' ? violation.message : `${field}: ${violation.message}`,
        location: sink.location,
        ...(field === '' ? {} : { field }),
      });
    }
    return { ...summarizeIssues(sink.issues), issues: sink.issues, manifest: { name: null, version: null, path: manifestPath } };
  }

  const manifest: LoadedAgentManifest = { ...parsed.data, __manifestPath: manifestPath };
  const agentDir = path.dirname(manifestPath);

  if (manifest.spec.rag) await validateRAGConfig(manifest, agentDir, sink);
  if (manifest.spec.resources) await validateResources(manifest, agentDir, sink);
  if (manifest.spec.prompts) await validatePrompts(manifest, agentDir, sink);

  return {
    ...summarizeIssues(sink.issues),
    issues: sink.issues,
    manifest: {
      name: manifest.metadata.name,
      version: manifest.metadata.version ?? null,
      path: manifestPath,
    },
  };
}

/**
 * Record a finding when `fullPath` cannot be reached: `AGENT_REFERENCE_MISSING`
 * when absent, `AGENT_REFERENCE_UNREADABLE` (with the OS message) for any other
 * refusal — "not found" would send the reader to create a file that is there.
 */
async function requireReachable(
  fullPath: string,
  subject: string,
  shown: string,
  sink: IssueSink,
  absentHint = ''
): Promise<void> {
  try {
    await fs.access(fullPath);
  } catch (error) {
    if (isPathAbsentError(error)) {
      report(sink, { code: 'AGENT_REFERENCE_MISSING', severity: 'error', message: `${subject} not found: ${shown}${absentHint}` });
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    report(sink, { code: 'AGENT_REFERENCE_UNREADABLE', severity: 'error', message: `${subject} could not be checked: ${shown} (${reason})` });
  }
}

/**
 * Validate RAG configuration
 */
async function validateRAGConfig(
  manifest: LoadedAgentManifest,
  agentDir: string,
  sink: IssueSink,
): Promise<void> {
  // Check if RAG database exists
  // Default location is .rag-db in agent directory
  const ragDbPath = safePath.join(agentDir, '.rag-db');
  await requireReachable(ragDbPath, 'RAG database', ragDbPath, sink, ". Run 'vat rag index' to create database.");

  // Warn if no RAG sources defined
  if (manifest.spec.rag) {
    const ragConfigs = Object.values(manifest.spec.rag);
    const hasSources = ragConfigs.some(config => config.sources);
    if (!hasSources) {
      report(sink, { code: 'AGENT_RAG_NO_SOURCES', severity: 'warning', message: 'RAG configuration defined but no sources specified' });
    }
  }
}

/**
 * Validate resource files exist
 */
async function validateResources(
  manifest: LoadedAgentManifest,
  agentDir: string,
  sink: IssueSink,
): Promise<void> {
  if (!manifest.spec.resources) return;

  for (const [resourceId, resource] of Object.entries(manifest.spec.resources)) {
    // Resource can be either a Resource object or a nested record of Resource objects
    if ('path' in resource && typeof resource.path === 'string') {
      await validateSingleResource(agentDir, resourceId, resource.path, sink);
    } else {
      await validateNestedResources(agentDir, resourceId, resource, sink);
    }
  }
}

/**
 * Validate a single resource file
 */
async function validateSingleResource(
  agentDir: string,
  resourceId: string,
  resourcePath: string,
  sink: IssueSink,
): Promise<void> {
  const fullPath = safePath.resolve(agentDir, resourcePath);
  await requireReachable(fullPath, `Resource '${resourceId}'`, resourcePath, sink);
}

/**
 * Validate nested resource files
 */
async function validateNestedResources(
  agentDir: string,
  resourceId: string,
  resourceRecord: Record<string, unknown>,
  sink: IssueSink,
): Promise<void> {
  for (const [nestedId, nestedResource] of Object.entries(resourceRecord)) {
    if (typeof nestedResource !== 'object' || !nestedResource || !('path' in nestedResource)) {
      continue;
    }

    const shown = nestedResource.path as string;
    await requireReachable(safePath.resolve(agentDir, shown), `Resource '${resourceId}.${nestedId}'`, shown, sink);
  }
}

/**
 * Validate prompt files exist
 */
async function validatePrompts(
  manifest: LoadedAgentManifest,
  agentDir: string,
  sink: IssueSink,
): Promise<void> {
  if (!manifest.spec.prompts) return;

  if (manifest.spec.prompts.system) {
    const ref = manifest.spec.prompts.system.$ref;
    await requireReachable(safePath.resolve(agentDir, ref), 'System prompt', ref, sink);
  }

  if (manifest.spec.prompts.user) {
    const ref = manifest.spec.prompts.user.$ref;
    await requireReachable(safePath.resolve(agentDir, ref), 'User prompt', ref, sink);
  }
}
