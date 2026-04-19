/**
 * Interpreter detection for MCP server commands.
 *
 * When an MCP server's `command` field is a well-known interpreter (python,
 * node), we treat it as an external CLI the plugin depends on — it must be
 * present on the target runtime. This gives MCP-rich plugins (especially
 * python-based ones) a meaningful `CAPABILITY_EXTERNAL_CLI` signal.
 *
 * Unknown/bespoke commands (e.g. `./scripts/my-server.sh`) are intentionally
 * left alone — we don't speculate about what they require.
 */

/** Canonical interpreter binary names VAT normalizes matches to. */
const CANONICAL_PYTHON = 'python3';
const CANONICAL_NODE = 'node';

/** Regex for python interpreter basenames: python, python2, python3, python3.11. */
// eslint-disable-next-line security/detect-unsafe-regex -- Bounded: matches `python` + optional digits + optional `.digits`. No unbounded backtracking.
const PYTHON_BASENAME = /^python(?:\d{1,3}(?:\.\d{1,3})?)?$/;
/** Regex for node interpreter basenames: node, nodejs. */
const NODE_BASENAME = /^(?:node|nodejs)$/;

/**
 * Normalize an MCP server command to a canonical external-CLI binary name,
 * or `undefined` if the command is not a recognized interpreter.
 *
 * Handles absolute paths (`/usr/bin/python3`, `/opt/homebrew/bin/node`),
 * versioned suffixes (`python3.11`), and plain names (`python3`, `node`).
 */
export function detectInterpreter(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;
  // Take the last segment after POSIX or Windows path separators; we don't use
  // node:path.basename because we need to handle BOTH separators regardless of
  // the host platform (an MCP config authored on Windows may be evaluated on
  // Linux CI and vice versa).
  // eslint-disable-next-line local/no-hardcoded-path-split -- Intentional cross-platform basename extraction from semi-structured MCP config strings (not filesystem paths).
  const segments = trimmed.split(/[/\\]/);
  const basename = segments.at(-1);
  if (!basename) return undefined;
  if (PYTHON_BASENAME.test(basename)) return CANONICAL_PYTHON;
  if (NODE_BASENAME.test(basename)) return CANONICAL_NODE;
  return undefined;
}

/**
 * Extract the command string from an `MCP_SERVER_COMMAND` evidence record's
 * matchText. The mcp-config-scanner emits matchText of the form
 * `MCP server "<name>" command: <command>`.
 *
 * Returns `undefined` if the pattern is unrecognized (e.g. evidence from a
 * different scanner shape).
 */
export function extractMcpCommandFromMatchText(matchText: string): string | undefined {
  const match = /command:\s*(\S.*)$/.exec(matchText);
  return match?.[1]?.trim();
}
