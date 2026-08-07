/**
 * @vibe-agent-toolkit/utils/zod
 *
 * Version-agnostic Zod type introspection via duck typing on `_def.typeName`,
 * so it works across Zod v3 and v4 even when library and consumer versions
 * differ. Pure — reaches no Node builtin. Isolating it here means consumers
 * who never touch Zod are not coupled to the `zod` peer range.
 */

export * from './zod-introspection.js';
