import { z } from 'zod';

export const ClaudeAuthConfigSchema = z
  .object({
    apiKeyHelper: z.string().optional(),
    forceLoginMethod: z.enum(['claudeai', 'console']).optional(),
    forceLoginOrgUUID: z.string().uuid().optional(),
  })
  .passthrough();

export type ClaudeAuthConfig = z.infer<typeof ClaudeAuthConfigSchema>;
