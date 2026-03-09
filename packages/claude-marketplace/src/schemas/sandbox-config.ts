import { z } from 'zod';

/**
 * Sandbox filesystem access rules.
 *
 * @see https://code.claude.com/docs/en/settings — "Sandbox Configuration" section
 */
export const SandboxFilesystemSchema = z
  .object({
    allowWrite: z.array(z.string()).optional(),
    denyWrite: z.array(z.string()).optional(),
    denyRead: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Sandbox network access rules.
 *
 * @see https://code.claude.com/docs/en/settings — "Sandbox Configuration" section
 */
export const SandboxNetworkSchema = z
  .object({
    allowUnixSockets: z.array(z.string()).optional(),
    allowAllUnixSockets: z.boolean().optional(),
    allowLocalBinding: z.boolean().optional(),
    allowedDomains: z.array(z.string()).optional(),
    /** Managed-only: only managed allowedDomains respected; non-allowed blocked without prompting */
    allowManagedDomainsOnly: z.boolean().optional(),
    httpProxyPort: z.number().int().optional(),
    socksProxyPort: z.number().int().optional(),
  })
  .passthrough();

/**
 * Sandbox configuration for bash command isolation.
 *
 * @see https://code.claude.com/docs/en/settings — "Sandbox Configuration" section
 */
export const SandboxConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    excludedCommands: z.array(z.string()).optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    filesystem: SandboxFilesystemSchema.optional(),
    network: SandboxNetworkSchema.optional(),
    enableWeakerNestedSandbox: z.boolean().optional(),
    enableWeakerNetworkIsolation: z.boolean().optional(),
  })
  .passthrough();

export type SandboxFilesystem = z.infer<typeof SandboxFilesystemSchema>;
export type SandboxNetwork = z.infer<typeof SandboxNetworkSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
