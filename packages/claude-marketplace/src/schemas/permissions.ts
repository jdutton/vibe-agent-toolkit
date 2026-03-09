import { z } from 'zod';

export const PermissionRuleSchema = z.string();

/**
 * Permission rules controlling tool access.
 *
 * @see https://code.claude.com/docs/en/settings — "Permissions" section
 */
export const PermissionsConfigSchema = z
  .object({
    allow: z.array(PermissionRuleSchema).optional(),
    deny: z.array(PermissionRuleSchema).optional(),
    ask: z.array(PermissionRuleSchema).optional(),
    defaultMode: z
      .enum(['default', 'acceptEdits', 'askEdits', 'autoEdit', 'readOnly', 'bypassPermissions'])
      .optional(),
    disableBypassPermissionsMode: z.enum(['disable']).optional(),
    additionalDirectories: z.array(z.string()).optional(),
  })
  .passthrough();

export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
