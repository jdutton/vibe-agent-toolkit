import { z } from 'zod';

/**
 * Authentication and API configuration fields.
 *
 * @see https://code.claude.com/docs/en/settings — "Authentication & API" section
 */
export const ClaudeAuthConfigSchema = z
  .object({
    apiKeyHelper: z.string().optional(),
    otelHeadersHelper: z.string().optional(),
    awsAuthRefresh: z.string().optional(),
    awsCredentialExport: z.string().optional(),
    forceLoginMethod: z.enum(['claudeai', 'console']).optional(),
    forceLoginOrgUUID: z.string().uuid().optional(),
  })
  .passthrough();

export type ClaudeAuthConfig = z.infer<typeof ClaudeAuthConfigSchema>;
