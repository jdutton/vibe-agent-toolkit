/**
 * Which REFUSAL a thrown value is — the one place a command's catch learns
 * whether the run failed on the invocation, the project, the environment, or
 * a defect in VAT.
 *
 * 🔑 **Dispatch on a code, never on a message.** A user's mistake is thrown as
 * a {@link CommandRefusalError} carrying its refusal code, or as a library
 * `VatError` whose `code` is mapped below; an unreadable input is coded
 * `INPUT_UNREADABLE` at the site that reads it. Everything else — an uncoded
 * errno included — a `TypeError`, a resolver bug, an invariant a
 * driver broke — is `INTERNAL_ERROR`, published with its stack. A blanket
 * `catch` that relabels "anything thrown here" as the user's fault is exactly
 * what this module exists to make unnecessary: it would publish VAT's own
 * defects as usage mistakes.
 *
 * Kept apart from the document writer so a helper that only needs to REFUSE
 * (`project-root-policy.ts`, `check-supervisor.ts`) does not load the
 * published-shape registry to do it.
 */

import { AGENT_MANIFEST_INVALID_CODE, AGENT_MANIFEST_NOT_FOUND_CODE, AGENT_MANIFEST_UNREADABLE_CODE } from '@vibe-agent-toolkit/agent-config';
import { AGENT_PACKAGE_ROOT_MISSING_CODE, AGENT_SOURCE_UNREADABLE_CODE, GIT_SUBPATH_INVALID_CODE, SKILL_TEST_REFUSAL_BY_ERROR_CODE } from '@vibe-agent-toolkit/agent-skills';
import {
  API_REQUEST_CODE,
  API_TRANSPORT_CODE,
  CLAUDE_USER_STATE_UNREADABLE_CODE,
  CLAUDE_USER_STATE_WRITE_FAILED_CODE,
  ORG_API_KEY_MISSING_CODE,
  PLUGIN_KEY_INVALID_CODE,
} from '@vibe-agent-toolkit/claude-marketplace';
import { CONFIG_LOAD_CODE, LINK_AUTH_CONFIG_CODE, PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { isVatError, RAG_INDEX_EMPTY_CODE, VatError } from '@vibe-agent-toolkit/utils';
import { YAML_EDIT_INPUT_REFUSED_CODE } from '@vibe-agent-toolkit/utils/yaml';

import { AGENT_NAME_ESCAPES_SCOPE_CODE } from '../commands/agent/install-path.js';
import { PLUGIN_SYMLINK_REFUSED_CODE } from '../commands/claude/plugin/tree-copy.js';

const COMMAND_REFUSAL = 'COMMAND_REFUSAL';

/**
 * The code a config that exists and could not be READ carries — the OS refused
 * it (permissions, a directory where the file should be). `config-loader.ts`'s
 * read of the adopter's own config is the one site that knows the errno is
 * about the user's input, so it throws this; the refusal is `INPUT_UNREADABLE`.
 */
export const CONFIG_UNREADABLE_CODE = 'CONFIG_UNREADABLE';

/** A refusal a command raises on purpose, carrying WHICH refusal. */
export class CommandRefusalError extends VatError {
  readonly refusal: RefusalCode;

  constructor(refusal: RefusalCode, message: string, options?: ErrorOptions) {
    super(COMMAND_REFUSAL, message, options);
    this.refusal = refusal;
  }
}

/** Library errors whose `code` already says which refusal they are. */
const REFUSAL_BY_ERROR_CODE: Readonly<Record<string, RefusalCode>> = {
  // A config file that exists and does not parse or validate (resources' parser and the CLI loader).
  [CONFIG_LOAD_CODE]: 'CONFIG_INVALID',
  // A config file that exists and the OS would not let VAT read.
  [CONFIG_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // A bundle argument the project does not declare under `okf.bundles`.
  OKF_UNKNOWN_BUNDLE: 'USAGE_INVALID',
  // A directory the OS would not list, under a `refuse` policy.
  DIRECTORY_LISTING_REFUSED: 'INPUT_UNREADABLE',
  // A symlink inside a tree being copied that points outside it (`CopyLinkEscapesSourceError`): the input's link.
  COPY_LINK_ESCAPES_SOURCE: 'INPUT_UNREADABLE',
  // A symlink that leads a following walk back into a directory it already entered: the input's loop.
  DIRECTORY_WALK_REVISITED: 'INPUT_UNREADABLE',
  // A git URL's `#ref:subpath` naming a path the clone does not hold, or one escaping it.
  [GIT_SUBPATH_INVALID_CODE]: 'USAGE_INVALID',
  // A `resources.linkAuth` provider that does not compile (`LinkAuthConfigError`): the config's mistake.
  [LINK_AUTH_CONFIG_CODE]: 'CONFIG_INVALID',
  // An agent path or name that names no manifest — the argument is the mistake.
  [AGENT_MANIFEST_NOT_FOUND_CODE]: 'USAGE_INVALID',
  // An agent manifest the OS refuses, or whose content is not YAML.
  [AGENT_MANIFEST_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // An agent manifest `loadAgentManifest` read and the schema rejects: the adopter's config.
  [AGENT_MANIFEST_INVALID_CODE]: 'CONFIG_INVALID',
  // `vat agent install|uninstall` with a name that is not one entry under the scope root.
  [AGENT_NAME_ESCAPES_SCOPE_CODE]: 'USAGE_INVALID',
  // `vat agent build` with no --output and no package.json around the agent to put the default in.
  [AGENT_PACKAGE_ROOT_MISSING_CODE]: 'USAGE_INVALID',
  // An agent's own source (system prompt, scripts/, LICENSE.txt, package.json) the OS will not read or stat.
  [AGENT_SOURCE_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // A SQL statement the projection store refused — the statement the operator passed is wrong.
  [PROJECTION_STATEMENT_REFUSED_CODE]: 'USAGE_INVALID',
  // A Claude Code registry, settings file or skills directory present and unreadable (or not JSON).
  [CLAUDE_USER_STATE_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // A plugin key argument that is not `<plugin>@<marketplace>`.
  [PLUGIN_KEY_INVALID_CODE]: 'USAGE_INVALID',
  // A plugin source holding a symlink no bundle can ship (`PluginSymlinkRefusedError`): the input, not VAT.
  [PLUGIN_SYMLINK_REFUSED_CODE]: 'INPUT_UNREADABLE',
  // An adopter's YAML (their config) that the surgical editor cannot take the edit into: not YAML, or the wrong shape at the path.
  [YAML_EDIT_INPUT_REFUSED_CODE]: 'CONFIG_INVALID',
  // A copy, write or removal in ~/.claude failed partway (install or uninstall): the run stopped, not VAT's defect.
  [CLAUDE_USER_STATE_WRITE_FAILED_CODE]: 'RUN_INCOMPLETE',
  // An org command run without the key its endpoint authenticates with: nothing was sent.
  [ORG_API_KEY_MISSING_CODE]: 'USAGE_INVALID',
  // The Anthropic API answered with a non-success status (`ApiRequestError`)…
  [API_REQUEST_CODE]: 'EXTERNAL_API_FAILED',
  // …or never answered at all (`ApiTransportError`).
  [API_TRANSPORT_CODE]: 'EXTERNAL_API_FAILED',
  // `vat rag query` over an index with no chunk table (rag-lancedb's query): nothing to search.
  // The constant lives in utils so this map need not load the optional backend that throws it.
  [RAG_INDEX_EMPTY_CODE]: 'INPUT_UNREADABLE',
  // `vat skill test run`: why the harness could not run, decided beside its error classes.
  ...SKILL_TEST_REFUSAL_BY_ERROR_CODE,
};

/**
 * Which refusal a thrown value is.
 *
 * Read by brand and `code`, not by `instanceof`, for the reason `isVatError`
 * gives: a `dist` copy of the class never matches a `src` instance.
 *
 * @param error - What the command's catch received
 * @returns A {@link CommandRefusalError}'s own code; a mapped library code; otherwise
 *   `INTERNAL_ERROR`. ⛔ No errno walk: an uncoded errno is not known to be
 *   about the user's INPUT — an output write, a temp directory, VAT's own
 *   shipped asset — so it is a defect report, with its stack, until the site
 *   that reads user input codes it.
 */
export function refusalCodeOf(error: unknown): RefusalCode {
  if (isVatError(error, COMMAND_REFUSAL)) return (error as CommandRefusalError).refusal;
  if (isVatError(error) && Object.hasOwn(REFUSAL_BY_ERROR_CODE, error.code)) {
    return REFUSAL_BY_ERROR_CODE[error.code] ?? 'INTERNAL_ERROR';
  }
  return 'INTERNAL_ERROR';
}

/**
 * The human sentence a thrown value carries: an `Error`'s message, or the
 * value itself spelled out.
 *
 * @param error - Anything a catch received
 */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
