/**
 * Shared JSON Schema generation for `generate:schemas` build scripts.
 *
 * Every package that generates committed `.schema.json` siblings from Zod
 * (agent-skills, resources, ...) writes files the same way: create the
 * output directory, convert with `zod-to-json-schema`, pretty-print, log.
 * This factory is that shared step, so each package's own script stays a
 * short list of `writeJsonSchema(name, Schema)` calls.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { type ZodType, type ZodTypeDef } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Create a `writeJsonSchema` function bound to one output directory.
 *
 * `outputDir` is created (recursively) immediately, matching every existing
 * caller's behavior of ensuring the directory exists before the first write.
 */
export function createJsonSchemaWriter(outputDir: string) {
  mkdirSyncReal(outputDir, { recursive: true });

  return function writeJsonSchema(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod-to-json-schema's own signature
    schema: ZodType<any, ZodTypeDef, any>,
    postProcess?: (s: Record<string, unknown>) => void,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zodToJsonSchema's return type
    const jsonSchema = zodToJsonSchema(schema, name) as Record<string, any>;
    if (postProcess) postProcess(jsonSchema);
    const path = safePath.join(outputDir, `${name}.json`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a controlled outputDir + caller-supplied name, not user input
    writeFileSync(path, JSON.stringify(jsonSchema, null, 2) + '\n');
    console.log(`✅ Generated: ${name}.json`);
  };
}
