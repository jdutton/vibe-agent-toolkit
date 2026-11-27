/**
 * The credentials file kinds the `data` instance never stores whole, whatever glob matches them: a
 * built-in rule no `include`, `jsonc` or default overrides. This module is the ONE place that
 * decides each kind's stance, and the one case rule (case-insensitive) every kind is matched under.
 *
 * ## What the rule is, and what it is not
 *
 * A data row set is stored in the projection store under the cache root, which CI saves to its
 * cache, and every row is answerable by any statement. Routing reads every member of the
 * population, and an untracked file no ignore rule covers is a member, so a token a tool wrote into
 * the working tree (and that was never committed) would otherwise be stored the moment a glob
 * matched its file.
 *
 * The list is CLOSED and matches by path name only. It covers the named kinds, and nothing else: a
 * secret in a file under any other name (a `secrets.yml`, a `kubeconfig.yaml`, a hard link to a
 * listed file, which no name check can detect) is routed like any ordinary file, and its values
 * become rows. The rule is "keep secrets out of files a glob routes", and this list is the backstop
 * for the common tool-written ones.
 *
 * Each kind has one stance:
 *
 * - **`ini`**: an `.npmrc`. Always routed by its name, whatever the globs say (only `exclude`
 *   removes it), to the `ini` variant, whose extractor keeps only a reviewed key allowlist
 *   (`data-ini.ts`) and drops every other key and section before any row is built.
 * - **`yarnrc`**: a `.yarnrc.yml` or `.yarnrc.yaml`. Routed, when a glob matches it, to the
 *   `yarnrc` variant, whose extractor keeps only a reviewed list of keys and drops every auth key
 *   and every URL that can carry a credential (`data-yarnrc.ts`).
 * - **`refuse`**: the file holds nothing but credentials, or its format interleaves them with
 *   settings line by line, so it is never routed. A path a glob would have routed is the
 *   `DATA_CREDENTIAL_FILE_NOT_ROUTED` warning, naming it, so a check author learns why its rows are
 *   absent. Only its path is ever named; its content is never parsed or stored (the population
 *   hashes an untracked file's bytes to key it, as it does every file).
 *
 * Matched case-insensitively, dot files as ordinary segments, at any depth. Adding an entry is a
 * code change reviewed as one.
 */

import picomatch from 'picomatch';

/** What the data instance does with one credentials file kind. */
type CredentialFileStance = 'ini' | 'yarnrc' | 'refuse';

/** One credentials file kind: the globs that name it, what it is, and the stance. */
interface CredentialFileKind {
  readonly globs: readonly string[];
  /** What the file is, for a message: never anything read from it. */
  readonly what: string;
  readonly stance: CredentialFileStance;
}

/** The credentials files, in the order they are asked; the first match decides. */
const CREDENTIAL_FILE_KINDS: readonly CredentialFileKind[] = [
  { globs: ['**/.yarnrc.yml', '**/.yarnrc.yaml'], what: 'Yarn settings, which can hold npmAuthToken and npmAuthIdent', stance: 'yarnrc' },
  { globs: ['**/.npmrc'], what: 'npm settings, which hold registry auth tokens', stance: 'ini' },
  { globs: ['**/.yarnrc'], what: 'Yarn 1 settings, which hold registry auth tokens', stance: 'refuse' },
  { globs: ['**/.netrc', '**/_netrc'], what: 'machine logins and passwords', stance: 'refuse' },
  { globs: ['**/.git-credentials'], what: 'git credential-store passwords', stance: 'refuse' },
  { globs: ['**/.pypirc'], what: 'Python package index passwords', stance: 'refuse' },
  { globs: ['**/.env', '**/.env.*'], what: 'environment variables, conventionally secrets', stance: 'refuse' },
  { globs: ['**/.docker/config.json'], what: 'Docker registry auths', stance: 'refuse' },
  { globs: ['**/.config/gh/hosts.yml', '**/.config/gh/hosts.yaml'], what: 'GitHub CLI OAuth tokens', stance: 'refuse' },
  { globs: ['**/.aws/credentials'], what: 'AWS access keys', stance: 'refuse' },
  { globs: ['**/.kube/config'], what: 'Kubernetes cluster credentials', stance: 'refuse' },
  { globs: ['**/.pgpass'], what: 'PostgreSQL passwords', stance: 'refuse' },
  { globs: ['**/.cargo/credentials', '**/.cargo/credentials.toml'], what: 'crates.io tokens', stance: 'refuse' },
  { globs: ['**/.gem/credentials'], what: 'RubyGems API keys', stance: 'refuse' },
  { globs: ['**/.terraformrc', '**/terraform.rc'], what: 'Terraform registry tokens', stance: 'refuse' },
  { globs: ['**/.ssh/**'], what: 'SSH keys and host settings', stance: 'refuse' },
  { globs: ['**/auth.json'], what: 'Composer registry and GitHub credentials', stance: 'refuse' },
  { globs: ['**/local.settings.json'], what: 'Azure Functions local settings, which hold connection strings', stance: 'refuse' },
  { globs: ['**/credentials.json'], what: 'tool credentials', stance: 'refuse' },
  { globs: ['**/client_secret*.json'], what: 'OAuth client secrets', stance: 'refuse' },
  { globs: ['**/*service-account*.json'], what: 'cloud service-account keys', stance: 'refuse' },
];

/** Every credentials glob is matched this way: dot files ordinary, case folded (a Windows `_NETRC`). */
const CREDENTIAL_GLOB_OPTIONS = { dot: true, nocase: true } as const;

const COMPILED: ReadonlyArray<{ readonly matches: (path: string) => boolean; readonly kind: CredentialFileKind }> = CREDENTIAL_FILE_KINDS
  .map((kind) => ({ matches: picomatch([...kind.globs], CREDENTIAL_GLOB_OPTIONS), kind }));

/** A credentials file's kind, as {@link credentialFileOf} answers it. */
interface CredentialFile {
  readonly what: string;
  readonly stance: CredentialFileStance;
}

/**
 * The credentials file kind a path names, or undefined for an ordinary file. Pure.
 *
 * @param relativePath - The path relative to the project root, forward slashes
 * @returns The kind, or undefined
 */
export function credentialFileOf(relativePath: string): CredentialFile | undefined {
  return COMPILED.find(({ matches }) => matches(relativePath))?.kind;
}

/**
 * The kinds never routed, as the docs state them: each refused kind's globs, quoted, generated from
 * {@link CREDENTIAL_FILE_KINDS} so a doc cannot list a different set than the code refuses. (An
 * `.npmrc` and a `.yarnrc.yml` are read through an allowlist and are not in it.) A drift test holds
 * every doc that quotes it to this text.
 */
export const REFUSED_CREDENTIAL_KINDS_PROSE: string = CREDENTIAL_FILE_KINDS
  .filter(({ stance }) => stance === 'refuse')
  .flatMap(({ globs }) => globs.map((glob) => '`' + glob.replace(/^\*\*\//, '') + '`'))
  .join(', ');
