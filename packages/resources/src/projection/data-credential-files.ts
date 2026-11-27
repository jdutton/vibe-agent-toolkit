/**
 * The credentials files the `data` instance never stores whole, whatever glob matches them: a
 * built-in rule no `include`, `jsonc` or default overrides.
 *
 * A data row set is stored in the projection store under the cache root, which CI saves to its
 * cache, and every row is answerable by any statement. Routing reads every member of the
 * population, and an untracked file no ignore rule covers is a member, so a token a tool wrote into
 * the working tree (and that was never committed) would otherwise be stored the moment a glob
 * matched its file. Each entry is one of two stances:
 *
 * - **`allowlist`**: the file's non-secret keys are useful to a check (`.yarnrc.yml`'s `nodeLinker`,
 *   `npmRegistryServer`, `packageExtensions`), so it is routed to a variant whose extractor keeps
 *   only a reviewed list of keys and drops every auth key at any depth (`data-yarnrc.ts`).
 * - **`refuse`**: the file holds nothing but credentials, or its format interleaves them with
 *   settings line by line, so it is never routed. A path a glob would have routed is the
 *   `DATA_CREDENTIAL_FILE_NOT_ROUTED` warning, naming it, so a check author learns why its rows are
 *   absent. Only its path is ever named; no byte of it is read.
 *
 * Matched case-insensitively, dot files as ordinary segments, at any depth. Adding an entry is a code
 * change reviewed as one.
 */

import picomatch from 'picomatch';

/** What the data instance does with one credentials file kind. */
type CredentialFileStance = 'allowlist' | 'refuse';

/** One credentials file kind: the globs that name it, what it is, and the stance. */
interface CredentialFileKind {
  readonly globs: readonly string[];
  /** What the file is, for a message: never anything read from it. */
  readonly what: string;
  readonly stance: CredentialFileStance;
}

/** The credentials files, in the order they are asked; the first match decides. */
const CREDENTIAL_FILE_KINDS: readonly CredentialFileKind[] = [
  { globs: ['**/.yarnrc.yml'], what: 'Yarn settings, which can hold npmAuthToken and npmAuthIdent', stance: 'allowlist' },
  { globs: ['**/.npmrc'], what: 'npm settings, which hold registry auth tokens', stance: 'refuse' },
  { globs: ['**/.yarnrc'], what: 'Yarn 1 settings, which hold registry auth tokens', stance: 'refuse' },
  { globs: ['**/.netrc', '**/_netrc'], what: 'machine logins and passwords', stance: 'refuse' },
  { globs: ['**/.git-credentials'], what: 'git credential-store passwords', stance: 'refuse' },
  { globs: ['**/.pypirc'], what: 'Python package index passwords', stance: 'refuse' },
  { globs: ['**/.env', '**/.env.*'], what: 'environment variables, conventionally secrets', stance: 'refuse' },
  { globs: ['**/.docker/config.json'], what: 'Docker registry auths', stance: 'refuse' },
  { globs: ['**/.config/gh/hosts.yml'], what: 'GitHub CLI OAuth tokens', stance: 'refuse' },
  { globs: ['**/.aws/credentials'], what: 'AWS access keys', stance: 'refuse' },
  { globs: ['**/.kube/config'], what: 'Kubernetes cluster credentials', stance: 'refuse' },
  { globs: ['**/.pgpass'], what: 'PostgreSQL passwords', stance: 'refuse' },
  { globs: ['**/.cargo/credentials', '**/.cargo/credentials.toml'], what: 'crates.io tokens', stance: 'refuse' },
  { globs: ['**/.gem/credentials'], what: 'RubyGems API keys', stance: 'refuse' },
  { globs: ['**/.terraformrc', '**/terraform.rc'], what: 'Terraform registry tokens', stance: 'refuse' },
  { globs: ['**/.ssh/**'], what: 'SSH keys and host settings', stance: 'refuse' },
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
