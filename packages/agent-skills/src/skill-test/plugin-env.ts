/**
 * plugin-env.ts — pure env assembly for the experimenter spawn.
 *
 * When the subject skill is plugin-distributed, its staged plugin root is exported
 * as `CLAUDE_PLUGIN_ROOT` so the harness mirrors a real plugin install: the skill's
 * own code reads `${CLAUDE_PLUGIN_ROOT}/skills/<name>/scripts/...` and finds the
 * file at the staged nesting (see staging.ts). Without it the first such call is
 * MODULE_NOT_FOUND (a wasted experimenter turn, logged as path-assumption friction).
 *
 * NOTE: it is unclear whether Claude Code itself sets `CLAUDE_PLUGIN_ROOT` when it
 * loads a plugin via `--plugin-dir`. We set it explicitly as a guarantee; if claude
 * also sets it, our value points at the same staged dir, so they agree.
 */

/**
 * Return a copy of `env` with `CLAUDE_PLUGIN_ROOT` set to `subjectPluginRoot` when
 * the subject is plugin-distributed. When `subjectPluginRoot` is null (standalone),
 * the env is returned unchanged. The input object is never mutated.
 */
export function withPluginRootEnv(
  env: NodeJS.ProcessEnv,
  subjectPluginRoot: string | null,
): NodeJS.ProcessEnv {
  if (subjectPluginRoot === null) return env;
  return { ...env, CLAUDE_PLUGIN_ROOT: subjectPluginRoot };
}
