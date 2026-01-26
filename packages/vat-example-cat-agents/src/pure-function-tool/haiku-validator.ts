import { createPureFunctionAgent } from '@vibe-agent-toolkit/agent-runtime';
import type { AgentResult } from '@vibe-agent-toolkit/agent-schema';
import { syllable } from 'syllable';

import type { Haiku, HaikuValidationResult } from '../types/schemas.js';

// SonarQube: Disable "Do not call Array#push() multiple times" - conditional pushes based on validation logic
// NOSONAR

/**
 * Common seasonal words (kigo) in English haiku
 */
const KIGO_PATTERNS = [
  // Spring
  'spring', 'blossom', 'cherry', 'rain', 'green', 'nest', 'egg',
  // Summer
  'summer', 'heat', 'thunder', 'cicada', 'butterfly', 'firefly',
  // Autumn/Fall
  'autumn', 'fall', 'leaf', 'leaves', 'harvest', 'moon', 'frost',
  // Winter
  'winter', 'snow', 'ice', 'cold', 'bare', 'gray', 'grey',
];

/**
 * Common cutting words/patterns (kireji) in English haiku
 * These create a pause or juxtaposition
 */
const KIREJI_PATTERNS = [
  '—', // em dash
  '...', // ellipsis
  '!', // exclamation
  ';', // semicolon
  ':', // colon
];

/**
 * Validates a haiku for proper syllable structure.
 *
 * Checks:
 * - Line 1: 5 syllables
 * - Line 2: 7 syllables
 * - Line 3: 5 syllables
 * - Optional: presence of kigo (seasonal reference)
 * - Optional: presence of kireji (cutting word)
 *
 * This is Professor Whiskers' domain - he's extremely strict about syllable counts.
 *
 * @param haiku - The haiku to validate
 * @returns Validation result with syllable counts and errors (wrapped in success)
 */
function validateHaikuLogic(haiku: Haiku): HaikuValidationResult {
  const line1Count = syllable(haiku.line1);
  const line2Count = syllable(haiku.line2);
  const line3Count = syllable(haiku.line3);

  const errors: string[] = [];

  if (line1Count !== 5) {
    errors.push(`Line 1 has ${line1Count} syllables, expected 5`);
  }

  if (line2Count !== 7) {
    errors.push(`Line 2 has ${line2Count} syllables, expected 7`);
  }

  if (line3Count !== 5) {
    errors.push(`Line 3 has ${line3Count} syllables, expected 5`);
  }

  // Check for kigo (seasonal reference)
  const fullText = `${haiku.line1} ${haiku.line2} ${haiku.line3}`.toLowerCase();
  const hasKigo = KIGO_PATTERNS.some((pattern) => fullText.includes(pattern));

  // Check for kireji (cutting word)
  const hasKireji = KIREJI_PATTERNS.some((pattern) =>
    [haiku.line1, haiku.line2, haiku.line3].some((line) => line.includes(pattern)),
  );

  return {
    valid: errors.length === 0,
    syllables: {
      line1: line1Count,
      line2: line2Count,
      line3: line3Count,
    },
    errors,
    hasKigo,
    hasKireji,
  };
}

/**
 * Validates a haiku (public API for direct use).
 * Returns the validation result directly without the envelope.
 */
export function validateHaiku(haiku: Haiku): HaikuValidationResult {
  return validateHaikuLogic(haiku);
}

/**
 * Generates a detailed critique of a haiku.
 * This is what Professor Whiskers would say.
 *
 * @param haiku - The haiku to critique
 * @returns A detailed critique string
 */
export function critiqueHaiku(haiku: Haiku): string {
  const result = validateHaikuLogic(haiku);
  const lines: string[] = [];

  lines.push('=== Professor Whiskers\' Haiku Critique ===\n');

  if (result.valid) {
    lines.push('✓ Syllable structure is IMPECCABLE. 5-7-5, as it should be.');
  } else {
    lines.push('✗ UNACCEPTABLE syllable structure!');
    for (const error of result.errors) {
      lines.push(`  • ${error}`);
    }
  }

  lines.push('');
  lines.push(`Syllable counts: ${result.syllables.line1}-${result.syllables.line2}-${result.syllables.line3}`);

  if (result.hasKigo) {
    lines.push('✓ Contains seasonal reference (kigo). Good.');
  } else {
    lines.push('⚠ No obvious seasonal reference detected. Traditional haiku should include kigo.');
  }

  if (result.hasKireji) {
    lines.push('✓ Contains cutting word/pause (kireji). Excellent.');
  } else {
    lines.push('⚠ No clear cutting word detected. Consider adding — or ... for juxtaposition.');
  }

  if (!result.valid) {
    lines.push('\n*adjusts spectacles disapprovingly*');
    lines.push('This requires REVISION. Come back when you understand syllable structure.');
  } else if (!result.hasKigo || !result.hasKireji) {
    lines.push('\n*tail twitches critically*');
    lines.push('Structurally sound, but lacking poetic depth. Acceptable, but not exemplary.');
  } else {
    lines.push('\n*nods approvingly*');
    lines.push('A proper haiku. You may proceed.');
  }

  return lines.join('\n');
}

/**
 * Haiku validator agent (wrapped with result envelope)
 *
 * Validates haiku structure (5-7-5 syllable pattern) and checks for
 * traditional elements like seasonal references (kigo) and cutting words (kireji).
 *
 * This is Professor Whiskers' domain - he's extremely strict about syllable counts.
 *
 * Returns OneShotAgentOutput with:
 * - result.status: 'success' (validation result) or 'error' (unexpected failure)
 * - result.data: HaikuValidationResult (includes valid boolean, syllable counts, errors)
 */
export const haikuValidatorAgent = createPureFunctionAgent(
  (haiku: Haiku): AgentResult<HaikuValidationResult, 'invalid-format'> => {
    try {
      const validationResult = validateHaikuLogic(haiku);
      return { status: 'success', data: validationResult };
    } catch (err) {
      // Unexpected errors (e.g., syllable library failure)
      if (err instanceof Error) {
        console.warn('Haiku validation error:', err.message);
      }
      return { status: 'error', error: 'invalid-format' };
    }
  },
  {
    name: 'haiku-validator',
    version: '1.0.0',
    description: 'Validates haiku syllable structure and traditional elements',
    archetype: 'pure-function-tool',
  }
);
