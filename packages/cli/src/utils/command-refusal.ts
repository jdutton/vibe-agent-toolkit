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
import {
  AGENT_PACKAGE_ROOT_MISSING_CODE,
  GIT_SUBPATH_INVALID_CODE,
  SKILL_TEST_REFUSAL_BY_ERROR_CODE,
} from '@vibe-agent-toolkit/agent-skills';
import {
  API_REQUEST_CODE,
  API_TRANSPORT_CODE,
  CLAUDE_USER_STATE_UNREADABLE_CODE,
  ORG_API_KEY_MISSING_CODE,
  PLUGIN_KEY_INVALID_CODE,
} from '@vibe-agent-toolkit/claude-marketplace';
import {
  CONFIG_LOAD_CODE,
  LINK_AUTH_CONFIG_CODE,
  OKF_UNKNOWN_BUNDLE_CODE,
  PROJECTION_STATEMENT_REFUSED_CODE,
} from '@vibe-agent-toolkit/resources';
import { fsFaultRefusal, type RefusalCode } from '@vibe-agent-toolkit/schema';
import {
  ASSET_REFERENCE_UNREADABLE_CODE,
  COPY_LINK_ESCAPES_SOURCE_CODE,
  DIRECTORY_WALK_REVISITED_CODE,
  FS_FAULT_CODE,
  type FsFaultError,
  isFsFaultError,
  isVatError,
  RAG_DATABASE_UNREADABLE_CODE,
  RAG_INDEX_EMPTY_CODE,
  TREE_DEST_HOLDS_SOURCE_CODE,
  TREE_DEST_NOT_OWNED_CODE,
  TREE_DEST_OCCUPIED_CODE,
  TREE_ROLLBACK_INCOMPLETE_CODE,
  TREE_SOURCE_HOLDS_DEST_CODE,
  VatError,
} from '@vibe-agent-toolkit/utils';
import { GIT_SNAPSHOT_UNREADABLE_CODE } from '@vibe-agent-toolkit/utils/git';
import { YAML_EDIT_INPUT_REFUSED_CODE } from '@vibe-agent-toolkit/utils/yaml';

import { AGENT_NAME_ESCAPES_SCOPE_CODE, PLUGIN_SYMLINK_REFUSED_CODE } from './command-error-codes.js';

const COMMAND_REFUSAL = 'COMMAND_REFUSAL';

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
  // A bundle argument the project does not declare under `okf.bundles`.
  [OKF_UNKNOWN_BUNDLE_CODE]: 'USAGE_INVALID',
  // A symlink inside a tree being copied that points outside it (`CopyLinkEscapesSourceError`): the input's link.
  [COPY_LINK_ESCAPES_SOURCE_CODE]: 'INPUT_UNREADABLE',
  // An entry of a tree being copied that the OS would not list, stat or read (or a dangling link): the input's.
  // A bare specifier whose package is installed but unreadable (a malformed package.json): the input, not "missing".
  [ASSET_REFERENCE_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // A symlink that leads a following walk back into a directory it already entered: the input's loop.
  [DIRECTORY_WALK_REVISITED_CODE]: 'INPUT_UNREADABLE',
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
  // A SQL statement the projection store refused — the statement the operator passed is wrong.
  [PROJECTION_STATEMENT_REFUSED_CODE]: 'USAGE_INVALID',
  // A Claude Code registry or settings file whose content VAT cannot use: not JSON, the wrong shape.
  [CLAUDE_USER_STATE_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // A plugin key argument that is not `<plugin>@<marketplace>`.
  [PLUGIN_KEY_INVALID_CODE]: 'USAGE_INVALID',
  // A plugin source holding a symlink no bundle can ship (`PluginSymlinkRefusedError`): the input, not VAT.
  [PLUGIN_SYMLINK_REFUSED_CODE]: 'INPUT_UNREADABLE',
  // An adopter's YAML (their config) that the surgical editor cannot take the edit into: not YAML, or the wrong shape at the path.
  [YAML_EDIT_INPUT_REFUSED_CODE]: 'CONFIG_INVALID',
  // A git snapshot refused because a file in the repository is unreadable: the input, named, not VAT.
  [GIT_SNAPSHOT_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // An org command run without the key its endpoint authenticates with: nothing was sent.
  [ORG_API_KEY_MISSING_CODE]: 'USAGE_INVALID',
  // The Anthropic API answered with a non-success status (`ApiRequestError`)…
  [API_REQUEST_CODE]: 'EXTERNAL_API_FAILED',
  // …or never answered at all (`ApiTransportError`).
  [API_TRANSPORT_CODE]: 'EXTERNAL_API_FAILED',
  // `vat rag query` over an index with no chunk table (rag-lancedb's query): nothing to search.
  // The constant lives in utils so this map need not load the optional backend that throws it.
  [RAG_INDEX_EMPTY_CODE]: 'INPUT_UNREADABLE',
  // A RAG database LanceDB cannot open or read (a table's manifest or data files are damaged).
  [RAG_DATABASE_UNREADABLE_CODE]: 'INPUT_UNREADABLE',
  // The tree-change planner's preflight, before anything is written. Something in the way of a destination
  // the user named — anything at a `must-be-free` one, or what a `vat-made` one's recogniser disowns (an
  // explicit `-o` holding what VAT did not produce) — is the invocation's to fix: `--force`, or another path.
  // Never inferred from an errno: an `EEXIST` at the moment of a write is the table's RUN_INCOMPLETE.
  [TREE_DEST_OCCUPIED_CODE]: 'USAGE_INVALID',
  [TREE_DEST_NOT_OWNED_CODE]: 'USAGE_INVALID',
  // A copy whose source and destination hold one another: the paths the user passed are the mistake.
  [TREE_SOURCE_HOLDS_DEST_CODE]: 'USAGE_INVALID',
  [TREE_DEST_HOLDS_SOURCE_CODE]: 'USAGE_INVALID',
  // A change failed and could not be fully undone: the user's previous tree is under a parked name, named.
  [TREE_ROLLBACK_INCOMPLETE_CODE]: 'RUN_INCOMPLETE',
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
 * @returns A {@link CommandRefusalError}'s own code; for a classified filesystem fault
 *   (`FsFaultError`, or a wrapper coded `FS_FAULT` that carries one), the schema table's row for its side, class and origin; a mapped
 *   library code; otherwise `INTERNAL_ERROR`. ⛔ No errno walk: an uncoded errno is not
 *   known to be about the user's INPUT — an output write, a temp directory, VAT's own
 *   shipped asset — so it is a defect report, with its stack, until the site that made
 *   the call classifies it.
 */
export function refusalCodeOf(error: unknown): RefusalCode {
  if (isVatError(error, COMMAND_REFUSAL)) return (error as CommandRefusalError).refusal;
  const fault = classifiedFaultOf(error);
  if (fault !== undefined) return fsFaultRefusal(fault.side, fault.faultClass, fault.origin).refusal;
  if (isVatError(error) && Object.hasOwn(REFUSAL_BY_ERROR_CODE, error.code)) {
    return REFUSAL_BY_ERROR_CODE[error.code] ?? 'INTERNAL_ERROR';
  }
  return 'INTERNAL_ERROR';
}

/**
 * The classified fault `error` stands for: itself, or — for a wrapper that kept the
 * fault's own `FS_FAULT` code (`ConfigLoadError`, which a caller may tolerate by
 * type) — the fault it carries as its `cause`. A wrapper never re-codes a fault, so
 * its refusal is the fault's.
 */
function classifiedFaultOf(error: unknown): FsFaultError | undefined {
  if (isFsFaultError(error)) return error;
  if (!isVatError(error, FS_FAULT_CODE)) return undefined;
  const { cause } = error as { cause?: unknown };
  return isFsFaultError(cause) ? cause : undefined;
}

/**
 * A refusal's published message: `message`, followed by the table row's remedy when
 * `error` is a classified filesystem fault — whose own message says only what the OS
 * refused, since the remedy is the table's to state. Never appended twice.
 *
 * @param message - The message the refusal already carries
 * @param error - The thrown value it came from
 */
export function withFsFaultRemedy(message: string, error: unknown): string {
  const fault = classifiedFaultOf(error);
  if (fault === undefined) return message;
  const { remedy } = fsFaultRefusal(fault.side, fault.faultClass, fault.origin);
  return message.includes(remedy) ? message : `${message}. ${remedy}`;
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
