export {
  applyDeclaredEnv,
  buildForwardedEnv,
  formatForwardedEnvLine,
  protectedEnvNames,
  type DeclaredEnvInput,
  type DeclaredEnvResult,
  type ForwardEnvOptions,
} from './env-scrub.js';
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
  killAllActiveClaudeChildren,
  spawnHeadlessClaude,
  type ClaudeSpawnArgs,
  type SpawnHeadlessOptions,
  type SpawnResult,
} from './spawn-claude.js';
export {
  detectInvocationFromTranscript,
  parseStreamJsonTranscript,
  type ParsedTranscript,
} from './transcript.js';
