/**
 * Intent-aware skill-resource verdict engine (issue #129, slice 3).
 *
 * Public surface: the {@link RuleContext} description, the pure {@link evaluate}
 * engine, and the registry-sourced {@link materializeIssue} constructor.
 */
export type {
  FileCopyRole,
  FileKind,
  ReferencedHow,
  RuleContext,
  RulePhase,
  RuleScope,
  RuleSubject,
} from './rule-context.js';
export { makeRuleContext } from './rule-context.js';
export { evaluate, materializeIssue, type MaterializeOpts } from './rule-engine.js';
