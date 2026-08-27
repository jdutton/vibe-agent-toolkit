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
    /**
     * Any string. Claude Code owns this vocabulary and extends it — `plan` and
     * `auto` both postdate the closed enum that used to sit here, and because
     * `settings-reader.ts` throws rather than degrades, either one took out the
     * entire settings audit on a file Claude Code itself accepts.
     *
     * Deliberately NOT a list of known modes with a warning for the rest: that is
     * the same promise in a softer voice, and it goes stale the same way with
     * nothing failing when someone forgets to extend it. Reading external data is
     * the liberal half of Postel's Law — see `.claude/rules/schema-strictness.md`.
     * A value that is not a string is still rejected; that is a malformed file
     * rather than a mode we have not met.
     */
    defaultMode: z.string().optional(),
    disableBypassPermissionsMode: z.enum(['disable']).optional(),
    additionalDirectories: z.array(z.string()).optional(),
  })
  .passthrough();

export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
