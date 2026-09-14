/**
 * ESLint rule: no-bare-executable-spawn
 *
 * Flags `spawn`, `spawnSync`, `execFile`, `execFileSync` or `execSync` whose
 * first argument is the string literal `'git'` or `'node'` — bare or through
 * a namespace (`cp.spawnSync('git', …)`).
 *
 * A bare name asks the OS to search `PATH` at spawn time, so a writable
 * directory on `PATH` is a place to plant a binary (SonarCloud S4036), and
 * `node` by name may not be the node running the caller. Resolve once and
 * spawn the absolute path: `process.execPath` for node in source;
 * `NODE_EXECUTABLE` / `gitExecutable()` from `@vibe-agent-toolkit/utils/testing`
 * in tests. Sonar sees new code only and named 13 of 84 sites; this rule sees
 * every file, so the class cannot regrow one PR at a time.
 *
 * @example
 * // BAD
 * spawnSync('git', ['status'], { cwd });
 *
 * // GOOD
 * spawnSync(gitExecutable(), ['status'], { cwd });
 */

'use strict';

const { calleeName } = require('./callee-name.cjs');

const SPAWN_CALLS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync']);
const BARE_NAMES = new Set(['git', 'node']);

/** The spawn-family callee name of a call, bare or namespaced, or null. */
function spawnCallName(call) {
  const name = calleeName(call);
  return name !== null && SPAWN_CALLS.has(name) ? name : null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow spawning 'git' or 'node' by bare name — resolve the executable once " +
        '(process.execPath; NODE_EXECUTABLE / gitExecutable() in tests) and spawn the absolute path',
      category: 'Filesystem and process',
      recommended: true,
      recommendedSeverity: 'error',
    },
    schema: [],
    messages: {
      bareName:
        "{{call}}('{{name}}', …) searches PATH at spawn time. Spawn an absolute path: " +
        "process.execPath for node; NODE_EXECUTABLE / gitExecutable() from '@vibe-agent-toolkit/utils/testing' in tests.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const call = spawnCallName(node);
        if (call === null) {
          return;
        }
        const first = node.arguments[0];
        if (first?.type === 'Literal' && typeof first.value === 'string' && BARE_NAMES.has(first.value)) {
          context.report({ node: first, messageId: 'bareName', data: { call, name: first.value } });
        }
      },
    };
  },
};
