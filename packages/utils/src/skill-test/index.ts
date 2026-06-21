export { buildForwardedEnv, type ForwardEnvOptions } from './env-scrub.js';
export {
  AuthPreflightError,
  probeAuthStatus,
  resolveAuth,
  type AuthMechanism,
  type AuthMode,
  type AuthStatusProbe,
  type AuthStatusResult,
  type ResolveAuthOptions,
  type ResolvedAuth,
} from './auth-resolver.js';
export {
  assembleClaudeArgs,
  spawnHeadlessClaude,
  type ClaudeSpawnArgs,
  type SpawnHeadlessOptions,
  type SpawnResult,
} from './spawn-claude.js';
