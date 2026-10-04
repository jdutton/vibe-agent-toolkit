/**
 * Which refusal a thrown value is: decided by code, never by message — and a
 * defect in VAT is never relabelled as the user's mistake.
 */

import { AGENT_MANIFEST_INVALID_CODE, AGENT_MANIFEST_NOT_FOUND_CODE, AGENT_MANIFEST_UNREADABLE_CODE } from '@vibe-agent-toolkit/agent-config';
import { AGENT_PACKAGE_ROOT_MISSING_CODE, AGENT_SOURCE_UNREADABLE_CODE, SKILL_PACKAGING_OUTPUT_FAILED_CODE, SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE } from '@vibe-agent-toolkit/agent-skills';
import { ApiRequestError, ApiTransportError, OrgApiClient, PLUGIN_SOURCE_UNREADABLE_CODE } from '@vibe-agent-toolkit/claude-marketplace';
import { CONFIG_UNREADABLE_CODE, LinkAuthConfigError, OKF_UNKNOWN_BUNDLE_CODE, okfBundleRuns, PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { ExitCode, type ErrorReport } from '@vibe-agent-toolkit/schema';
import { COPY_LINK_ESCAPES_SOURCE_CODE, CopyLinkEscapesSourceError, DIRECTORY_LISTING_REFUSED_CODE, DIRECTORY_WALK_REVISITED_CODE, DirectoryWalkRevisitedError, RAG_DATABASE_NOT_REMOVABLE_CODE, RAG_DATABASE_REMOVAL_INCOMPLETE_CODE, RAG_DATABASE_UNREADABLE_CODE, RAG_INDEX_EMPTY_CODE, VatError } from '@vibe-agent-toolkit/utils';
import { GIT_SNAPSHOT_UNREADABLE_CODE } from '@vibe-agent-toolkit/utils/git';
import { updateYamlIn } from '@vibe-agent-toolkit/utils/yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentNameEscapesScopeError } from '../../src/commands/agent/install-path.js';
import { PluginSymlinkRefusedError } from '../../src/commands/claude/plugin/tree-copy.js';
import { parseBudgetSeconds, requireSupervisableFlags } from '../../src/commands/resources/check-supervisor.js';
import { requireKnownCheck } from '../../src/commands/resources/check.js';
import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../src/utils/command-refusal.js';
import { endWithRefusal, NOTHING_FINISHED } from '../../src/utils/document-writer.js';

/** An output write the OS refused — `ard emit --output <read-only>`. */
const DENIED_OUTPUT = 'EACCES: permission denied, open \'/read-only/ard.json\'';

/** What `fn` threw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refusalCodeOf', () => {
  it('reads a CommandRefusalError\'s own code and a library error\'s by its code', () => {
    expect(refusalCodeOf(new CommandRefusalError('USAGE_INVALID', 'no such bundle'))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(new VatError('CONFIG_LOAD', 'bad yaml'))).toBe('CONFIG_INVALID');
    expect(refusalCodeOf(new VatError(OKF_UNKNOWN_BUNDLE_CODE, 'nope'))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(new VatError(DIRECTORY_LISTING_REFUSED_CODE, 'EACCES'))).toBe('INPUT_UNREADABLE');
  });

  // The constant the map is keyed with is the one its thrower throws: a renamed code cannot leave one side behind.
  it('keys the copy-escape and walk-revisit refusals with the code their throwers carry', () => {
    expect(new CopyLinkEscapesSourceError('/bundle/link', '/bundle').code).toBe(COPY_LINK_ESCAPES_SOURCE_CODE);
    expect(new DirectoryWalkRevisitedError('/bundle/loop', '/bundle').code).toBe(DIRECTORY_WALK_REVISITED_CODE);
  });

  // A full disk or an unwritable output directory: the build did not finish, and nothing about the skill is wrong.
  it('reads a skill build stopped by its own output as RUN_INCOMPLETE, never as a defect in VAT', () => {
    expect(refusalCodeOf(new VatError(SKILL_PACKAGING_OUTPUT_FAILED_CODE, 'ENOSPC'))).toBe('RUN_INCOMPLETE');
  });

  // An explicit `-o` already holding something VAT did not produce: refused before anything is written.
  it('reads an occupied package output path as the invocation\'s USAGE_INVALID', () => {
    expect(refusalCodeOf(new VatError(SKILL_PACKAGING_OUTPUT_OCCUPIED_CODE, 'keep/ already exists'))).toBe('USAGE_INVALID');
  });

  // One unreadable file in a git repository refuses the whole snapshot: the input, never a VAT defect.
  it('reads a git snapshot refused by an unreadable file as INPUT_UNREADABLE', () => {
    expect(refusalCodeOf(new VatError(GIT_SNAPSHOT_UNREADABLE_CODE, 'secret.txt'))).toBe('INPUT_UNREADABLE');
  });

  it('reads a plugin symlink no bundle can ship as the input\'s refusal', () => {
    expect(refusalCodeOf(new PluginSymlinkRefusedError([{ path: 'hooks/out.json', reason: 'escapes-source' }]))).toBe('INPUT_UNREADABLE');
  });

  it('reads a plugin source that is not there to install as the input\'s refusal, not a failed write', () => {
    expect(refusalCodeOf(new VatError(PLUGIN_SOURCE_UNREADABLE_CODE, 'ENOENT'))).toBe('INPUT_UNREADABLE');
  });

  it('reads a statement the projection store refused as the operator\'s USAGE_INVALID', () => {
    expect(refusalCodeOf(new VatError(PROJECTION_STATEMENT_REFUSED_CODE, 'no such column: nope'))).toBe('USAGE_INVALID');
  });

  it('reads a resources.linkAuth provider that does not compile as CONFIG_INVALID', () => {
    expect(refusalCodeOf(new LinkAuthConfigError('providers[0]', 'rewrite[0].when', new Error('bad regex')))).toBe('CONFIG_INVALID');
  });

  it('reads an agent path naming no manifest as USAGE_INVALID, and one that cannot be read as INPUT_UNREADABLE', () => {
    expect(refusalCodeOf(new VatError(AGENT_MANIFEST_NOT_FOUND_CODE, 'No agent manifest found'))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(new VatError(AGENT_MANIFEST_UNREADABLE_CODE, 'EACCES'))).toBe('INPUT_UNREADABLE');
  });

  it('reads an agent manifest the schema rejects, thrown by the loader, as CONFIG_INVALID', () => {
    // `agent run`/`build`/`install` load through `loadAgentManifest`: a user's
    // invalid manifest is their config's mistake, never a defect in VAT.
    expect(refusalCodeOf(new VatError(AGENT_MANIFEST_INVALID_CODE, 'Agent manifest validation failed'))).toBe('CONFIG_INVALID');
  });

  it('reads an agent build with nowhere to put its default output as USAGE_INVALID', () => {
    expect(refusalCodeOf(new VatError(AGENT_PACKAGE_ROOT_MISSING_CODE, 'Could not find package.json'))).toBe('USAGE_INVALID');
  });

  it('reads an agent name that is not one entry under the scope root as USAGE_INVALID', () => {
    expect(refusalCodeOf(new AgentNameEscapesScopeError('../victim', '/skills'))).toBe('USAGE_INVALID');
  });

  // A copied tree whose link escapes it, or leads a following walk back into itself: the input, not VAT.
  it('reads a symlink that escapes a copied tree, or loops a walk, as INPUT_UNREADABLE', () => {
    expect(refusalCodeOf(new CopyLinkEscapesSourceError('/bundle/link', '/bundle'))).toBe('INPUT_UNREADABLE');
    expect(refusalCodeOf(new DirectoryWalkRevisitedError('/bundle/loop', '/bundle'))).toBe('INPUT_UNREADABLE');
  });

  it('reads an agent source file the OS will not read as INPUT_UNREADABLE', () => {
    expect(refusalCodeOf(new VatError(AGENT_SOURCE_UNREADABLE_CODE, 'EISDIR'))).toBe('INPUT_UNREADABLE');
  });

  it('reads an org command run without its key as USAGE_INVALID, and a refused or unanswered API call as EXTERNAL_API_FAILED', () => {
    const keyless = new OrgApiClient({});
    expect(refusalCodeOf(thrownBy(() => keyless.buildAdminHeaders()))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(thrownBy(() => keyless.buildSkillsHeaders()))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(new ApiRequestError('API error 401', 401, undefined))).toBe('EXTERNAL_API_FAILED');
    expect(refusalCodeOf(new ApiTransportError('socket hang up', 0))).toBe('EXTERNAL_API_FAILED');
  });

  it('reads a RAG query over an index with nothing in it as INPUT_UNREADABLE, by the code rag-lancedb throws', () => {
    expect(refusalCodeOf(new VatError(RAG_INDEX_EMPTY_CODE, 'No data indexed yet'))).toBe('INPUT_UNREADABLE');
  });

  it('reads a RAG database whose table cannot be opened as INPUT_UNREADABLE, never a defect in VAT', () => {
    expect(refusalCodeOf(new VatError(RAG_DATABASE_UNREADABLE_CODE, 'cannot be read'))).toBe('INPUT_UNREADABLE');
  });

  it('reads a RAG database path that will not be removed as USAGE_INVALID, and one removed partway as RUN_INCOMPLETE', () => {
    expect(refusalCodeOf(new VatError(RAG_DATABASE_NOT_REMOVABLE_CODE, 'a symbolic link'))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(new VatError(RAG_DATABASE_REMOVAL_INCOMPLETE_CODE, 'ENOTEMPTY'))).toBe('RUN_INCOMPLETE');
  });

  it('reads the coded config read failure as INPUT_UNREADABLE', () => {
    expect(refusalCodeOf(new VatError(CONFIG_UNREADABLE_CODE, 'EACCES: permission denied'))).toBe('INPUT_UNREADABLE');
  });

  it('does NOT read an uncoded errno as the user\'s input — an output write the OS refused is INTERNAL_ERROR', () => {
    const denied = Object.assign(new Error(DENIED_OUTPUT), { code: 'EACCES' });
    expect(refusalCodeOf(denied)).toBe('INTERNAL_ERROR');
    expect(refusalCodeOf(new Error('wrapped', { cause: denied }))).toBe('INTERNAL_ERROR');
    const absent = Object.assign(new Error('ENOENT: no such file or directory, open \'dist/asset.json\''), { code: 'ENOENT' });
    expect(refusalCodeOf(absent)).toBe('INTERNAL_ERROR');
  });

  it('leaves everything unanticipated INTERNAL_ERROR — a TypeError, an uncoded Error, an unmapped code', () => {
    expect(refusalCodeOf(new TypeError('cannot read properties of undefined'))).toBe('INTERNAL_ERROR');
    expect(refusalCodeOf(new Error('boom'))).toBe('INTERNAL_ERROR');
    expect(refusalCodeOf(new VatError('SOMETHING_ELSE', 'x'))).toBe('INTERNAL_ERROR');
  });
});

describe('the user mistakes the migrated verbs refuse, by the code they carry', () => {
  it('an adopter config the surgical YAML editor cannot take the edit into is CONFIG_INVALID', () => {
    // `vat skill test configure` edits the adopter's own config through updateYamlIn.
    expect(refusalCodeOf(thrownBy(() => updateYamlIn('key: [unterminated', ['key'], 'v')))).toBe('CONFIG_INVALID');
    expect(refusalCodeOf(thrownBy(() => updateYamlIn('foo:\n  bar: 1\n', ['foo'], 'v')))).toBe('CONFIG_INVALID');
  });

  it('an undeclared okf bundle argument is USAGE_INVALID', () => {
    expect(refusalCodeOf(thrownBy(() => okfBundleRuns(undefined, '/project', { bundle: 'nope' })))).toBe('USAGE_INVALID');
  });

  it('a bad --budget, --budget beside --cost-log, and an unknown --check are USAGE_INVALID', () => {
    expect(refusalCodeOf(thrownBy(() => parseBudgetSeconds('abc')))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(thrownBy(() => parseBudgetSeconds(' ')))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(thrownBy(() => requireSupervisableFlags({ costLog: 'x', budgetRaw: '60', budgetSecs: 60 })))).toBe('USAGE_INVALID');
    expect(refusalCodeOf(thrownBy(() => requireKnownCheck(['builtin'], {}, 'nope')))).toBe('USAGE_INVALID');
  });
});

describe('a VAT defect is published as one', () => {
  it('a TypeError surfaces as INTERNAL_ERROR, with its stack on stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const defect = new TypeError('resolver bug');

    endWithRefusal('okf validate', refusalCodeOf(defect), defect, 'json', { strict: false }, NOTHING_FINISHED);

    const document = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join('')) as ErrorReport<unknown>;
    expect(document.error).toEqual({ code: 'INTERNAL_ERROR', message: 'resolver bug' });
    expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('TypeError: resolver bug\n    at ');
    expect(exit.mock.calls).toEqual([[ExitCode.ERROR]]);
  });
});

describe('an uncoded errno is published as a defect, with its diagnostics', () => {
  it('an output write the OS refused ends INTERNAL_ERROR with the stack on stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const denied = Object.assign(new Error(DENIED_OUTPUT), { code: 'EACCES' });

    endWithRefusal('ard emit', refusalCodeOf(denied), denied, 'json', { strict: false }, NOTHING_FINISHED);

    const document = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join('')) as ErrorReport<unknown>;
    expect(document.error.code).toBe('INTERNAL_ERROR');
    expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(`Error: ${DENIED_OUTPUT}\n    at `);
  });
});

describe('errorMessageOf', () => {
  it('reads an Error\'s message and spells out anything else', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom');
    expect(errorMessageOf('plain')).toBe('plain');
  });
});
