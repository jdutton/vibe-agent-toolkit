import { createPureFunctionAgent } from '@vibe-agent-toolkit/agent-runtime';
import type { AgentResult } from '@vibe-agent-toolkit/agent-schema';
import { z } from 'zod';

import {
  CatCharacteristicsSchema,
  type CatCharacteristics,
  type NameValidationResult,
} from '../types/schemas.js';

// SonarQube: Disable "Do not call Array#push() multiple times" - conditional pushes based on validation logic
// NOSONAR

/**
 * Input schema for name validation
 */
export const NameValidationInputSchema = z.object({
  name: z.string().describe('The proposed cat name to validate'),
  characteristics: CatCharacteristicsSchema.optional().describe('Cat characteristics for context-aware validation'),
});

export type NameValidationInput = z.infer<typeof NameValidationInputSchema>;

/**
 * Rules for cat names that Madam Fluffington finds ABSOLUTELY UNACCEPTABLE
 */
const FORBIDDEN_PATTERNS = [
  // Too common/boring
  { pattern: /^(fluffy|kitty|cat|pussy)$/i, reason: 'Far too common and beneath any respectable feline' },
  { pattern: /^mr\.?\s/i, reason: 'Lacks the sophistication of proper nobility. Use "Sir" or "Lord" instead' },
  { pattern: /^ms\.?\s/i, reason: 'Lacks the elegance of proper titles. Use "Lady" or "Dame" instead' },

  // Undignified
  { pattern: /\d/, reason: 'Numbers are for accountants, not aristocats' },
  { pattern: /(butt|poop|fart|stink)/i, reason: 'ABSOLUTELY VULGAR! I refuse to even comment further' },
  { pattern: /(dumb|stupid|silly|goofy)/i, reason: 'Insulting to feline intelligence and dignity' },

  // Food-based (questionable)
  { pattern: /(muffin|cupcake|cookie|pizza)/i, reason: 'Naming nobility after peasant food? I think not!' },

  // Too simple
  { pattern: /^[a-z]{1,3}$/i, reason: 'Too short! A proper name requires at least 4 letters' },
];

/**
 * Patterns that indicate EXCELLENT taste (gets Madam Fluffington's approval)
 */
const DISTINGUISHED_PATTERNS = [
  { pattern: /^(sir|lord|duke|baron|count|earl)/i, reason: 'Proper masculine nobility!' },
  { pattern: /^(lady|dame|duchess|baroness|countess)/i, reason: 'Proper feminine nobility!' },
  { pattern: /^(princess|prince|king|queen|empress|emperor)/i, reason: 'Royalty! As all cats deserve!' },
  { pattern: /(sterling|diamond|sapphire|emerald|pearl)/i, reason: 'Named after precious things, as befits a cat' },
  { pattern: /(whiskers|paws|purr)/i, reason: 'Celebrates noble feline attributes' },
];

/**
 * Characteristics-based validation rules
 */
interface CharacteristicRule {
  check: (cat: CatCharacteristics) => boolean;
  createMessage: (name: string, cat: CatCharacteristics) => string;
  severity: 'invalid' | 'questionable';
}

const CHARACTERISTIC_RULES: CharacteristicRule[] = [
  {
    check: (cat) => cat.physical.furColor.toLowerCase().includes('orange') ||
                    cat.physical.furColor.toLowerCase().includes('ginger'),
    createMessage: (name) =>
      name.toLowerCase().includes('tiger') || name.toLowerCase().includes('marmalade')
        ? 'Acceptable for an orange cat, though a bit obvious'
        : 'For an ORANGE cat? This name lacks proper acknowledgment of their majestic coloring!',
    severity: 'questionable',
  },
  {
    check: (cat) => cat.physical.furColor.toLowerCase().includes('black'),
    createMessage: (name) =>
      name.toLowerCase().includes('shadow') ||
      name.toLowerCase().includes('midnight') ||
      name.toLowerCase().includes('noir')
        ? 'Appropriately mysterious for a black cat'
        : 'A black cat deserves a name befitting their elegant darkness!',
    severity: 'questionable',
  },
  {
    check: (cat) => cat.physical.size === 'tiny' || cat.physical.size === 'small',
    createMessage: (name) =>
      name.length > 15
        ? 'This name is longer than the cat! Show some proportion, please!'
        : 'Size-appropriate naming shows good judgment',
    severity: 'questionable',
  },
  {
    check: (cat) => cat.behavioral.personality.some((p) =>
      p.toLowerCase().includes('lazy') || p.toLowerCase().includes('sleepy')),
    createMessage: (name) =>
      /^(snooze|doze|nap|sleepy|lazy)/i.test(name)
        ? 'A bit on-the-nose, but I appreciate honesty'
        : 'This name suggests far too much energy for such a languid creature',
    severity: 'questionable',
  },
];

/**
 * Checks if a name matches any forbidden patterns.
 */
function checkForbiddenPatterns(name: string): NameValidationResult | null {
  for (const forbidden of FORBIDDEN_PATTERNS) {
    if (forbidden.pattern.test(name)) {
      return {
        status: 'invalid',
        reason: `*flicks tail disdainfully* "${name}"? ${forbidden.reason}.`,
        suggestedFixes: [
          'Consider a proper noble title (Sir, Lady, Duke, Duchess)',
          'Think of precious stones or metals (Sterling, Diamond, Sapphire)',
          'Reference classical literature or royalty',
        ],
      };
    }
  }
  return null;
}

/**
 * Checks if a name matches any distinguished patterns.
 */
function checkDistinguishedPatterns(name: string): NameValidationResult | null {
  for (const distinguished of DISTINGUISHED_PATTERNS) {
    if (distinguished.pattern.test(name)) {
      return {
        status: 'valid',
        reason: `*purrs approvingly* "${name}"! ${distinguished.reason}. You have excellent taste!`,
      };
    }
  }
  return null;
}

/**
 * Applies characteristic-based validation rules.
 */
function applyCharacteristicRules(
  name: string,
  characteristics: CatCharacteristics,
  suggestedFixes: string[],
): NameValidationResult | null {
  for (const rule of CHARACTERISTIC_RULES) {
    if (rule.check(characteristics)) {
      const message = rule.createMessage(name, characteristics);
      if (rule.severity === 'invalid') {
        return {
          status: 'invalid',
          reason: `*narrows eyes* ${message}`,
          suggestedFixes: ['Reconsider this name given the cat\'s characteristics'],
        };
      }
      suggestedFixes.push(message);
    }
  }
  return null;
}

/**
 * Validates a cat name according to Madam Fluffington's VERY PARTICULAR standards.
 *
 * Madam Fluffington is:
 * - A Persian cat of impeccable breeding
 * - Extremely judgmental about proper feline nomenclature
 * - Believes all cats deserve names befitting royalty
 * - Has NO PATIENCE for vulgar or common names
 * - Considers characteristics when judging name appropriateness
 *
 * @param name - The proposed name
 * @param characteristics - The cat's characteristics (optional, but provides better validation)
 * @returns Validation result with status and reasoning
 */
export function validateCatName(
  name: string,
  characteristics?: CatCharacteristics,
): NameValidationResult {
  const suggestedFixes: string[] = [];

  // Check forbidden patterns
  const forbiddenResult = checkForbiddenPatterns(name);
  if (forbiddenResult) {
    return forbiddenResult;
  }

  // Check distinguished patterns (gets immediate approval)
  const distinguishedResult = checkDistinguishedPatterns(name);
  if (distinguishedResult) {
    return distinguishedResult;
  }

  // If we have characteristics, apply those rules
  if (characteristics) {
    const characteristicResult = applyCharacteristicRules(name, characteristics, suggestedFixes);
    if (characteristicResult) {
      return characteristicResult;
    }
  }

  // If we got here with characteristic warnings, mark as questionable
  if (suggestedFixes.length > 0) {
    return {
      status: 'questionable',
      reason: `*considers carefully* "${name}" is... acceptable, I suppose. ${suggestedFixes[0]}`,
      suggestedFixes: suggestedFixes.slice(1),
    };
  }

  // No forbidden patterns, no distinguished patterns, no characteristic issues
  // This is the "meh" category
  return {
    status: 'questionable',
    reason: `*sniffs* "${name}" is adequate, though it lacks a certain... je ne sais quoi. It would be acceptable for a common house cat, but surely THIS cat deserves better?`,
    suggestedFixes: [
      'Add a noble title prefix',
      'Consider names from classical literature',
      'Think of precious materials or gems',
      'Reference their most distinguished characteristic',
    ],
  };
}

/**
 * Generates Madam Fluffington's full critique of a name choice.
 *
 * @param name - The proposed name
 * @param characteristics - The cat's characteristics
 * @returns A detailed critique in Madam Fluffington's voice
 */
export function critiqueCatName(
  name: string,
  characteristics?: CatCharacteristics,
): string {
  const result = validateCatName(name, characteristics);
  const lines: string[] = [];

  lines.push('=== Madam Fluffington\'s Naming Critique ===\n');
  lines.push('*adjusts diamond collar and regards you with piercing blue eyes*\n');

  if (characteristics) {
    lines.push('The cat in question:');
    const furPattern = characteristics.physical.furPattern
      ? ` (${characteristics.physical.furPattern})`
      : '';
    lines.push(`  • Fur: ${characteristics.physical.furColor}${furPattern}`);
    if (characteristics.physical.breed) {
      lines.push(`  • Breed: ${characteristics.physical.breed}`);
    }
    lines.push(`  • Personality: ${characteristics.behavioral.personality.join(', ')}`);
    lines.push('');
  }

  lines.push(`Proposed name: "${name}"`);
  lines.push(`Verdict: ${result.status.toUpperCase()}\n`);
  lines.push(result.reason);

  if (result.suggestedFixes && result.suggestedFixes.length > 0) {
    lines.push('\n*extends one elegant paw*');
    lines.push('May I suggest:');
    for (const fix of result.suggestedFixes) {
      lines.push(`  • ${fix}`);
    }
  }

  if (result.status === 'valid') {
    lines.push('\n*purrs contentedly*');
    lines.push('You may proceed with this name. I approve.');
  } else if (result.status === 'invalid') {
    lines.push('\n*turns away and begins grooming*');
    lines.push('I refuse to discuss this further until you present a PROPER name.');
  } else {
    lines.push('\n*tail swishes thoughtfully*');
    lines.push('I shall tolerate this name, but know that I find it... uninspired.');
  }

  return lines.join('\n');
}

/**
 * Name validator agent
 *
 * Validates cat names according to Madam Fluffington's strict standards of
 * feline nobility and proper nomenclature. Checks for forbidden patterns,
 * distinguished titles, and appropriateness based on cat characteristics.
 */
export const nameValidatorAgent = createPureFunctionAgent(
  (input: NameValidationInput): AgentResult<NameValidationResult, 'invalid-format'> => {
    try {
      // Validate input schema
      const parsed = NameValidationInputSchema.safeParse(input);
      if (!parsed.success) {
        return { status: 'error', error: 'invalid-format' };
      }

      const validationResult = validateCatName(parsed.data.name, parsed.data.characteristics);
      return { status: 'success', data: validationResult };
    } catch (err) {
      // Unexpected errors (e.g., pattern matching failure)
      if (err instanceof Error) {
        console.warn('Name validation error:', err.message);
      }
      return { status: 'error', error: 'invalid-format' };
    }
  },
  {
    name: 'name-validator',
    version: '1.0.0',
    description: 'Validates cat names for proper nobility conventions and appropriateness',
    archetype: 'pure-function-tool',
  }
);
