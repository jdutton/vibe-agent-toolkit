/**
 * The `.` barrel's runtime export set — a ratchet, both ways. How to react when
 * this fails is written on `findBarrelDrift` in
 * `packages/dev-tools/src/pin-barrel-exports.ts`; in one line: a removal is a
 * breaking change (restore it, or record it in CHANGELOG.md), an addition is
 * deliberate and needs a consumer outside this package before it is added here.
 */

import { describe, expect, it } from 'vitest';

import { findBarrelDrift } from '../../dev-tools/src/pin-barrel-exports.js';

const BARREL_EXPORTS = [
  'ApprovalRequestInputSchema',
  'ApprovalResultSchema',
  'BREED_DATABASE',
  'BreedAdvisorInputSchema',
  'BreedAdvisorOutputSchema',
  'BreedMatchSchema',
  'CatCharacteristicsSchema',
  'ChoiceRequestInputSchema',
  'ChoiceResultSchema',
  'CustomApprovalRequestInputSchema',
  'CustomApprovalResultSchema',
  'DescriptionParserInputSchema',
  'HaikuGeneratorInputSchema',
  'HaikuSchema',
  'HaikuValidationResultSchema',
  'NameGeneratorInputSchema',
  'NameSuggestionSchema',
  'NameValidationInputSchema',
  'NameValidationResultSchema',
  'PhotoAnalyzerInputSchema',
  'SelectionProfileSchema',
  'analyzePhoto',
  'breedAdvisorAgent',
  'critiqueCatName',
  'critiqueHaiku',
  'descriptionParserAgent',
  'haikuGeneratorAgent',
  'haikuValidatorAgent',
  'matchBreeds',
  'nameGeneratorAgent',
  'nameValidatorAgent',
  'parseDescription',
  'photoAnalyzerAgent',
  'requestApproval',
  'requestApprovalAgent',
  'requestChoice',
  'requestChoiceAgent',
  'requestCustomApproval',
  'requestCustomApprovalAgent',
  'validateCatName',
  'validateHaiku',
];

describe('@vibe-agent-toolkit/vat-example-cat-agents — the `.` barrel export surface', () => {
  it('exports exactly the recorded set, sorted — nothing added, dropped, or out of order', async () => {
    expect(findBarrelDrift(await import('../src/index.js'), BARREL_EXPORTS)).toEqual({ added: [], removed: [], unsorted: [] });
  });
});
