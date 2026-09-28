/**
 * The verdict facet's verb matrix: which vat invocations one subject gets.
 *
 * Wave-A spellings. Each verb names the argv that makes that verb PUBLISH a
 * finding list, because a verdict is exit code plus findings and a verb whose
 * default output carries no findings measures only half of that:
 *
 * - `skills validate` gets `--verbose`. Legacy `skills validate` prints its
 *   finding list only under that flag (`packages/cli/src/commands/skills/validate.ts`),
 *   and a `Report<T>` build accepts it as a progress flag. The two arms share
 *   one argv only while both accept it — {@link VerdictVerbSpec.args} receives
 *   the arm's {@link InstrumentVersion} so a future divergence is a change to
 *   one function rather than a second matrix.
 * - The `Report<T>`-era verbs that choose a format are asked for JSON.
 *
 * The three `buildVerbs` verbs write into the tree they run in (`dist/`, a
 * marketplace staging area), so they never run against a subject: capture runs
 * them in an APFS clone of it (see `clone.ts`).
 */

import type { InstrumentVersion } from '../../envelope/coordinate.js';

/** Every verb a subjects file may list. */
export const VERDICT_VERB_NAMES = [
  'audit',
  'skills-validate',
  'resources-validate',
  'resources-check',
  'context-all',
  'context-path',
  'resources-query',
] as const;

/** One verb a subjects file may list. */
export type VerdictVerbName = (typeof VERDICT_VERB_NAMES)[number];

/** The verbs `buildVerbs: true` adds, run in a clone rather than the subject. */
export const VERDICT_BUILD_VERB_NAMES = ['build', 'verify', 'marketplace-publish-dry-run'] as const;

/** One of the clone-only verbs. */
export type VerdictBuildVerbName = (typeof VERDICT_BUILD_VERB_NAMES)[number];

/** What a verb needs to know about its subject to spell its argv. */
export interface VerbSubject {
  /** The subject root, absolute; also the cwd every invocation runs in. */
  readonly path: string;
  /** The one path `context-path` asks about, as the subjects file wrote it. */
  readonly contextPath: string | undefined;
  /** One entry per SQL file, in subjects-file order. */
  readonly queries: readonly VerbQuery[];
}

/** One SQL file a `resources-query` invocation runs. */
export interface VerbQuery {
  /** The file as the subjects file named it — the row's label, never re-derived. */
  readonly file: string;
  /** The file's text, passed to vat as the SQL argument. */
  readonly sql: string;
}

/** One vat invocation, and the row name its result is stored and compared under. */
export interface VerbInvocation {
  /**
   * The row name: the verb's own name, or `resources-query:<file>` for a verb
   * that runs once per SQL file. It is what a `verdict-deltas.yaml` entry's
   * `verb` names.
   */
  readonly name: string;
  readonly argv: readonly string[];
}

/** One verb of the matrix. */
export interface VerdictVerbSpec<TName extends string = VerdictVerbName> {
  readonly name: TName;
  /**
   * The invocations this verb makes on one subject.
   *
   * @param subject - What the verb needs to know about its subject
   * @param instrument - The arm the argv is for (see this module's docstring)
   * @returns One invocation per run — one per SQL file for `resources-query`
   */
  readonly args: (subject: VerbSubject, instrument: InstrumentVersion) => readonly VerbInvocation[];
}

/**
 * A verb that runs exactly once with a fixed argv.
 *
 * @param name - The verb and row name
 * @param argv - Its argv, given the subject root
 * @returns The spec
 */
function once<TName extends string>(
  name: TName,
  argv: (subject: VerbSubject) => readonly string[],
): VerdictVerbSpec<TName> {
  return { name, args: (subject) => [{ name, argv: argv(subject) }] };
}

/** The subject-verb matrix, keyed by name. */
const SUBJECT_VERBS: { readonly [K in VerdictVerbName]: VerdictVerbSpec<K> } = {
  audit: once('audit', (s) => ['audit', s.path]),
  'skills-validate': once('skills-validate', (s) => ['skills', 'validate', s.path, '--verbose']),
  'resources-validate': once('resources-validate', (s) => [
    'resources',
    'validate',
    s.path,
    '--format',
    'json',
  ]),
  'resources-check': once('resources-check', (s) => ['resources', 'check', s.path, '--format', 'json']),
  'context-all': once('context-all', () => ['claude', 'context', '--all', '--format', 'json']),
  'context-path': once('context-path', (s) => [
    'claude',
    'context',
    // The subjects schema requires `contextPath` whenever this verb is listed;
    // the fallback is unreachable from a parsed subjects file.
    s.contextPath ?? '',
    '--format',
    'json',
  ]),
  'resources-query': {
    name: 'resources-query',
    args: (s) =>
      s.queries.map((query) => ({
        name: `resources-query:${query.file}`,
        argv: ['resources', 'query', query.sql, s.path, '--format', 'json'],
      })),
  },
};

/** The clone-only verbs, in the order they run (build before what reads its output). */
const BUILD_VERBS: readonly VerdictVerbSpec<VerdictBuildVerbName>[] = [
  once('build', () => ['build']),
  once('verify', () => ['verify']),
  once('marketplace-publish-dry-run', () => ['claude', 'marketplace', 'publish', '--dry-run']),
];

/**
 * @param name - A verb a subjects file listed
 * @returns Its spec
 */
export function verdictVerb(name: VerdictVerbName): VerdictVerbSpec {
  return SUBJECT_VERBS[name] as VerdictVerbSpec;
}

/**
 * The invocations of the clone-only verbs, run in the clone rather than the subject.
 *
 * @param subject - The CLONE, as the verbs will see it
 * @param instrument - The arm the argv is for
 * @returns One invocation per clone-only verb, in run order
 */
export function buildVerbInvocations(
  subject: VerbSubject,
  instrument: InstrumentVersion,
): readonly VerbInvocation[] {
  return BUILD_VERBS.flatMap((spec) => spec.args(subject, instrument));
}
