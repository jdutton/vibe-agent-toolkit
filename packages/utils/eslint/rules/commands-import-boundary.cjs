/**
 * ESLint rule: commands-import-boundary
 *
 * In a command module — a file under one of the configured command
 * directories — flags any import of the filesystem (`node:fs`,
 * `node:fs/promises`, `fs`, `fs/promises`) and any import whose specifier
 * matches a configured forbidden-module pattern (a package's internals, a
 * local parser or walker module).
 *
 * A command's job is to parse arguments, call a seam, and render a report. The
 * moment it opens a directory itself it has become a fifth enumeration lane
 * nobody documented: `docs/contributing/command-lane-table.md` names the
 * walkers every population must come through, and one command carrying its
 * own ~700-line walker beside them was the audit finding behind this rule.
 * The boundary is syntactic — an import is an import — so it holds at the
 * desk rather than in a review.
 *
 * Shapes covered: static `import`, `import type` is IGNORED (a type does no
 * I/O), `export … from`, dynamic `import('…')` and `require('…')` with a
 * literal specifier.
 *
 * Options:
 * - `commandGlobs: string[]` — repo-relative directories that hold commands
 *   (default `['packages/cli/src/commands/']`). A trailing `/**` is accepted
 *   and ignored; matching is by anchored directory prefix, so nested command
 *   directories are covered.
 * - `forbiddenModules: string[]` — regex sources tested against the import
 *   specifier (default `['^@vibe-agent-toolkit/resources/']`: the barrel is a
 *   seam, a subpath is an internal).
 * - `allowFiles: string[]` — repo-relative paths of today's offenders, the
 *   ratchet. Name files, never directories.
 *
 * @example
 * // BAD — the command is now a walker
 * import { readdirSync } from 'node:fs';
 *
 * // GOOD — the population comes through a declared lane
 * import { crawlDirectory } from '@vibe-agent-toolkit/utils/crawl';
 */

'use strict';

const {
  createExemptDirectoryMatcher,
  createExemptPathMatcher,
} = require('./exempt-path-matcher.cjs');

const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);
const DEFAULT_COMMAND_DIRS = ['packages/cli/src/commands/'];
const DEFAULT_FORBIDDEN = ['^@vibe-agent-toolkit/resources/'];

/** Strip a trailing glob so `packages/cli/src/commands/**` reads as its directory. */
function toDirectory(entry) {
  return entry.endsWith('/**') ? entry.slice(0, -2) : entry;
}

/** The string value of a literal module specifier, or null. */
function literalSpecifier(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow filesystem and internal-module imports in command modules — a command calls a ' +
        'declared enumeration lane, it does not become one',
      recommended: false,
      recommendedSeverity: 'warn',
    },
    schema: [
      {
        type: 'object',
        properties: {
          commandGlobs: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          forbiddenModules: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          allowFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      fsImport:
        "Command modules do not import '{{source}}': reading the tree here makes this command an " +
        'undeclared enumeration lane. Go through a seam in @vibe-agent-toolkit/utils or ' +
        '@vibe-agent-toolkit/resources (see docs/contributing/command-lane-table.md).',
      forbiddenModule:
        "Command modules do not import '{{source}}' (matches forbidden pattern /{{pattern}}/): " +
        'it is an internal, not a seam. Import the barrel or the declared lane instead.',
    },
  },

  create(context) {
    const options = context.options?.[0] ?? {};
    const filename = context.filename ?? context.getFilename();
    const commandDirs = (options.commandGlobs ?? DEFAULT_COMMAND_DIRS).map(toDirectory);
    const isCommandFile = createExemptDirectoryMatcher(commandDirs);
    const isAllowed = createExemptPathMatcher(options.allowFiles ?? []);
    if (!isCommandFile(filename) || isAllowed(filename)) {
      return {};
    }

    const forbidden = (options.forbiddenModules ?? DEFAULT_FORBIDDEN).map((pattern) => ({
      pattern,
      // eslint-disable-next-line security/detect-non-literal-regexp -- the option is a regex source by contract: a config-time string written by the repo, not user data
      regex: new RegExp(pattern, 'u'),
    }));

    function check(node, source) {
      if (source === null) {
        return;
      }
      if (FS_MODULES.has(source)) {
        context.report({ node, messageId: 'fsImport', data: { source } });
        return;
      }
      const hit = forbidden.find(({ regex }) => regex.test(source));
      if (hit) {
        context.report({ node, messageId: 'forbiddenModule', data: { source, pattern: hit.pattern } });
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind !== 'type') {
          check(node, literalSpecifier(node.source));
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && node.exportKind !== 'type') {
          check(node, literalSpecifier(node.source));
        }
      },
      ExportAllDeclaration(node) {
        check(node, literalSpecifier(node.source));
      },
      ImportExpression(node) {
        check(node, literalSpecifier(node.source));
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          check(node, literalSpecifier(node.arguments[0]));
        }
      },
    };
  },
};
