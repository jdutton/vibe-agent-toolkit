/**
 * The two `markdown-it` rules `markdown-it-parser.ts` wraps, typed.
 *
 * `markdown-it` publishes `"./*"` in its `exports` map, so these module paths
 * are supported entry points rather than a reach into internals — but
 * `@types/markdown-it` ships declarations only for the state classes, not for
 * the rule modules themselves. These two declarations are what let a wrapper
 * call the original rule under `noImplicitAny`.
 *
 * ⚠️ Wrapping is the only way to observe a rule's *extent*. `Ruler` has no
 * public getter that returns a rule by name, so a wrapper cannot recover the
 * function it is replacing from the instance; it has to import it.
 */

declare module 'markdown-it/lib/rules_block/reference.mjs' {
  import type { RuleBlock } from 'markdown-it/lib/parser_block.mjs';

  const reference: RuleBlock;
  export default reference;
}

declare module 'markdown-it/lib/rules_inline/link.mjs' {
  import type { RuleInline } from 'markdown-it/lib/parser_inline.mjs';

  const link: RuleInline;
  export default link;
}
