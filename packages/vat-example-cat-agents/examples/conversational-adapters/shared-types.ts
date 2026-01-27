/**
 * Shared types for conversational runtime adapters
 */

import type { SelectionProfile } from '../../src/types/schemas.js';

/**
 * Session state for breed advisor
 */
export interface BreedAdvisorState {
  profile: SelectionProfile;
}
