/**
 * `@vibe-agent-toolkit/utils/project`
 *
 * Project-root discovery: `findProjectRoot` (config-anchored, then git-anchored)
 * plus the narrower `findConfigFile` / `findNodeWorkspaceRoot` probes and the
 * cache reset used by long-lived processes.
 *
 * Node-only (walks the filesystem via `node:fs`), but **dependency-free**: this
 * entry resolves with zero third-party packages installed. That property is the
 * whole reason it exists as a separate entry rather than barrel-only.
 *
 * This subpath was withdrawn once and restored. The withdrawal measured the wrong
 * thing: it asked "are these four functions useful to our primary adopter?" — and
 * they largely are not, for the reasons documented on the guard test in
 * `test/package-exports.test.ts`. But the question that decides whether an entry
 * should exist is "how heavy is the only remaining door?" With `./project` gone,
 * the sole route to these functions was the `.` barrel, which reaches
 * `handlebars`, `yaml`, `picomatch`, `ignore` and `which`. A consumer that avoids
 * the barrel on graph-weight grounds — which is the entire premise of this
 * package's subpath layout — could no longer reach a capability whose own code
 * imports nothing but `node:fs` and `node:path`.
 *
 * The functions remain VAT-shaped and are documented as such in README.md: they
 * look for `vibe-agent-toolkit.config.yaml`, then `.git/`. If your notion of a
 * root is a `pnpm-workspace.yaml`, a `turbo.json`, or a lockfile, that ladder is
 * not your ladder and a short walk-up of your own is more honest. Publishing the
 * entry is not a claim that it fits every repo — only that reaching it should not
 * cost five third-party packages.
 */

export {
  findConfigFile,
  findNodeWorkspaceRoot,
  findProjectRoot,
  resetProjectRootCaches,
} from './project-utils.js';
