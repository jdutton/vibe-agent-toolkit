/**
 * Cat breed knowledge database for the breed advisor agent.
 * Contains comprehensive breed profiles with traits aligned to music preferences.
 */

import type { SelectionProfile } from '../types/schemas.js';

export type ActivityLevel = 'couch-companion' | 'playful-moderate' | 'active-explorer' | 'high-energy-athlete';
export type GroomingNeeds = 'minimal' | 'weekly' | 'daily';
export type MusicGenre = 'classical' | 'jazz' | 'rock' | 'metal' | 'pop' | 'country' | 'electronic' | 'none';
export type Size = 'small' | 'medium' | 'large';

// Constants for duplicated strings
const ACTIVITY_COUCH_COMPANION: ActivityLevel = 'couch-companion';
const ACTIVITY_PLAYFUL_MODERATE: ActivityLevel = 'playful-moderate';
const ACTIVITY_ACTIVE_EXPLORER: ActivityLevel = 'active-explorer';
const ACTIVITY_HIGH_ENERGY: ActivityLevel = 'high-energy-athlete';

export interface BreedProfile {
  name: string;
  traits: {
    activityLevel: ActivityLevel[];
    groomingNeeds: GroomingNeeds;
    suitableForApartment: boolean;
    goodWithKids: boolean;
    goodWithPets: boolean;
    hypoallergenic: boolean;
    musicAlignment: MusicGenre[];
    temperament: string;
    size: Size;
  };
  description: string;
}

export const BREED_DATABASE: BreedProfile[] = [
  {
    name: 'Persian',
    traits: {
      activityLevel: [ACTIVITY_COUCH_COMPANION],
      groomingNeeds: 'daily',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['classical'],
      temperament: 'Calm, gentle, and affectionate. Enjoys quiet environments and a predictable routine.',
      size: 'medium',
    },
    description: 'Known for their luxurious long coat and sweet personality. Persians are the ultimate lap cats, preferring a serene environment with classical music. They require daily grooming but reward their owners with unwavering loyalty and gentle companionship.',
  },
  {
    name: 'Ragdoll',
    traits: {
      activityLevel: [ACTIVITY_COUCH_COMPANION, ACTIVITY_PLAYFUL_MODERATE],
      groomingNeeds: 'weekly',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['classical', 'pop'],
      temperament: 'Docile, relaxed, and people-oriented. Known for going limp when picked up.',
      size: 'large',
    },
    description: 'Famous for their tendency to go limp when held, Ragdolls are large, gentle cats with striking blue eyes. They enjoy both relaxing classical melodies and upbeat pop tunes. Perfect for families, they are patient with children and get along well with other pets.',
  },
  {
    name: 'Siamese',
    traits: {
      activityLevel: [ACTIVITY_PLAYFUL_MODERATE, ACTIVITY_ACTIVE_EXPLORER],
      groomingNeeds: 'minimal',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['jazz'],
      temperament: 'Vocal, intelligent, and social. Forms strong bonds with owners.',
      size: 'medium',
    },
    description: 'One of the most recognizable breeds with distinctive color points and blue eyes. Siamese cats are highly intelligent, vocal, and thrive on interaction. They resonate with jazz music, appreciating its complexity and improvisational nature. Very social and demand attention.',
  },
  {
    name: 'Bengal',
    traits: {
      activityLevel: [ACTIVITY_ACTIVE_EXPLORER, ACTIVITY_HIGH_ENERGY],
      groomingNeeds: 'minimal',
      suitableForApartment: false,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['jazz', 'rock'],
      temperament: 'Energetic, playful, and curious. Loves water and climbing.',
      size: 'medium',
    },
    description: 'With their wild leopard-like appearance, Bengals are extremely active and athletic. They need plenty of space and stimulation. Their high energy matches well with jazz and rock music. Known for their love of water and climbing, they require interactive play and mental challenges.',
  },
  {
    name: 'Maine Coon',
    traits: {
      activityLevel: [ACTIVITY_PLAYFUL_MODERATE, ACTIVITY_ACTIVE_EXPLORER],
      groomingNeeds: 'weekly',
      suitableForApartment: false,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['rock', 'country'],
      temperament: 'Gentle giant, friendly, and adaptable. Often called "dogs of the cat world".',
      size: 'large',
    },
    description: 'One of the largest domestic cat breeds, Maine Coons are known for their dog-like personalities. They are friendly, sociable, and great with families. Their rugged nature aligns with rock and country music. Despite their size, they are gentle and adapt well to various living situations.',
  },
  {
    name: 'Abyssinian',
    traits: {
      activityLevel: [ACTIVITY_ACTIVE_EXPLORER, ACTIVITY_HIGH_ENERGY],
      groomingNeeds: 'minimal',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['metal', 'rock'],
      temperament: 'Extremely active, curious, and playful. Always on the move.',
      size: 'medium',
    },
    description: 'Ancient breed with a wild appearance and boundless energy. Abyssinians are constantly in motion, exploring every corner of their environment. Their intense energy matches metal and rock music. They are intelligent, social, and require lots of interactive play and stimulation.',
  },
  {
    name: 'Sphynx',
    traits: {
      activityLevel: [ACTIVITY_PLAYFUL_MODERATE, ACTIVITY_ACTIVE_EXPLORER],
      groomingNeeds: 'weekly',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: true,
      musicAlignment: ['electronic'],
      temperament: 'Extroverted, energetic, and affectionate. Loves attention and warmth.',
      size: 'medium',
    },
    description: 'Hairless and striking, Sphynx cats have a unique appearance that matches their quirky personalities. They are warm to the touch and love human contact. Their modern, unconventional nature aligns with electronic music. Hypoallergenic and perfect for those with cat allergies.',
  },
  {
    name: 'Devon Rex',
    traits: {
      activityLevel: [ACTIVITY_PLAYFUL_MODERATE, ACTIVITY_ACTIVE_EXPLORER],
      groomingNeeds: 'minimal',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['electronic', 'pop'],
      temperament: 'Mischievous, playful, and people-oriented. Often called "monkeys in cat suits".',
      size: 'small',
    },
    description: 'With their large ears, curly coat, and impish personality, Devon Rex cats are highly entertaining. They are acrobatic, playful, and love being the center of attention. Their quirky nature resonates with electronic and pop music. Very social and bond closely with their families.',
  },
  {
    name: 'Russian Blue',
    traits: {
      activityLevel: [ACTIVITY_COUCH_COMPANION, ACTIVITY_PLAYFUL_MODERATE],
      groomingNeeds: 'minimal',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: true,
      musicAlignment: ['none', 'classical'],
      temperament: 'Reserved, intelligent, and loyal. Can be shy with strangers.',
      size: 'medium',
    },
    description: 'Known for their shimmering blue-gray coat and green eyes, Russian Blues are elegant and reserved. They prefer quiet environments and may not appreciate music at all, though they can tolerate classical. Hypoallergenic and perfect for those seeking a calm, loyal companion.',
  },
  {
    name: 'Domestic Shorthair',
    traits: {
      activityLevel: [ACTIVITY_COUCH_COMPANION, ACTIVITY_PLAYFUL_MODERATE, ACTIVITY_ACTIVE_EXPLORER],
      groomingNeeds: 'minimal',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['pop', 'country'],
      temperament: 'Varied - each cat is unique. Generally adaptable and friendly.',
      size: 'medium',
    },
    description: 'The most common cat in North America, Domestic Shorthairs are mixed breed cats with diverse personalities. They adapt well to various lifestyles and music preferences, though pop and country are common favorites. Each cat is unique, making them unpredictable but wonderful companions.',
  },
  {
    name: 'American Shorthair',
    traits: {
      activityLevel: [ACTIVITY_PLAYFUL_MODERATE],
      groomingNeeds: 'minimal',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['country', 'pop'],
      temperament: 'Easygoing, affectionate, and adaptable. Great family cats.',
      size: 'medium',
    },
    description: 'A true American breed, these cats are known for their robust health and easygoing nature. They are playful without being hyperactive and enjoy country and pop music. Excellent with children and other pets, they make ideal family companions.',
  },
  {
    name: 'Scottish Fold',
    traits: {
      activityLevel: [ACTIVITY_COUCH_COMPANION, ACTIVITY_PLAYFUL_MODERATE],
      groomingNeeds: 'weekly',
      suitableForApartment: true,
      goodWithKids: true,
      goodWithPets: true,
      hypoallergenic: false,
      musicAlignment: ['classical', 'jazz'],
      temperament: 'Sweet-tempered, calm, and adaptable. Enjoys human company.',
      size: 'medium',
    },
    description: 'Recognized by their distinctive folded ears, Scottish Folds are gentle, sweet-natured cats. They enjoy both calm classical music and sophisticated jazz. They adapt well to different living situations and get along with everyone. Known for sitting in unusual positions.',
  },
];

export interface BreedMatch {
  breed: string;
  matchScore: number;
  reasoning: string;
}

interface ScoringResult {
  score: number;
  reason?: string;
}

/**
 * Score music preference alignment
 */
function scoreMusicPreference(profile: SelectionProfile, breed: BreedProfile): ScoringResult {
  if (profile.musicPreference && breed.traits.musicAlignment.includes(profile.musicPreference as MusicGenre)) {
    return {
      score: 30,
      reason: `music preference (${profile.musicPreference}) aligns perfectly`,
    };
  }
  return { score: 0 };
}

/**
 * Score activity level match
 */
function scoreActivityLevel(profile: SelectionProfile, breed: BreedProfile): ScoringResult {
  if (profile.activityLevel && breed.traits.activityLevel.includes(profile.activityLevel as ActivityLevel)) {
    return {
      score: 20,
      reason: `activity level (${profile.activityLevel}) matches well`,
    };
  }
  return { score: 0 };
}

/**
 * Score living space compatibility
 */
function scoreLivingSpace(profile: SelectionProfile, breed: BreedProfile): ScoringResult {
  if (!profile.livingSpace) {
    return { score: 0 };
  }

  if (profile.livingSpace === 'apartment' && breed.traits.suitableForApartment) {
    return { score: 15, reason: 'suitable for apartment living' };
  }

  if (profile.livingSpace === 'apartment' && !breed.traits.suitableForApartment) {
    return { score: -20, reason: 'not ideal for apartments (penalty)' };
  }

  // Any breed works for houses/farms
  return { score: 10, reason: 'plenty of space available' };
}

/**
 * Score grooming compatibility
 */
function scoreGrooming(profile: SelectionProfile, breed: BreedProfile): ScoringResult {
  if (!profile.groomingTolerance) {
    return { score: 0 };
  }

  if (profile.groomingTolerance === breed.traits.groomingNeeds) {
    return {
      score: 15,
      reason: `grooming needs (${breed.traits.groomingNeeds}) match tolerance`,
    };
  }

  // Check if grooming tolerance is higher than needs (okay)
  const toleranceLevels: Record<GroomingNeeds, number> = { minimal: 0, weekly: 1, daily: 2 };
  const needsLevels: Record<GroomingNeeds, number> = { minimal: 0, weekly: 1, daily: 2 };

  if (toleranceLevels[profile.groomingTolerance as GroomingNeeds] >= needsLevels[breed.traits.groomingNeeds]) {
    return { score: 8, reason: 'grooming needs are manageable' };
  }

  return { score: -10, reason: 'grooming needs exceed tolerance (penalty)' };
}

/**
 * Score family composition compatibility
 */
function scoreFamilyComposition(profile: SelectionProfile, breed: BreedProfile): ScoringResult {
  if (!profile.familyComposition) {
    return { score: 0 };
  }

  if (profile.familyComposition === 'young-kids' && breed.traits.goodWithKids) {
    return { score: 10, reason: 'great with young children' };
  }

  if (profile.familyComposition === 'older-kids' && breed.traits.goodWithKids) {
    return { score: 10, reason: 'good with older children' };
  }

  if (profile.familyComposition === 'multi-pet' && breed.traits.goodWithPets) {
    return { score: 10, reason: 'gets along well with other pets' };
  }

  if (profile.familyComposition === 'single' || profile.familyComposition === 'couple') {
    return { score: 5, reason: 'suitable for adult household' };
  }

  return { score: 0 };
}

/**
 * Match breeds to a selection profile using scoring algorithm
 *
 * Scoring:
 * - Music preference: 30 points (CRITICAL factor, 2x weight)
 * - Activity level: 20 points
 * - Living space: 15 points
 * - Grooming tolerance: 15 points
 * - Family composition: 10 points
 * - Penalties: -10 to -20 per mismatch
 *
 * Hard filters:
 * - allergies=true → only hypoallergenic
 * - young-kids → only goodWithKids
 */
export function matchBreeds(profile: SelectionProfile): BreedMatch[] {
  // Return empty if no factors to match
  const factorCount = [
    profile.musicPreference,
    profile.activityLevel,
    profile.livingSpace,
    profile.groomingTolerance,
    profile.familyComposition,
    profile.allergies === undefined ? undefined : 'allergies',
  ].filter(Boolean).length;

  if (factorCount === 0) {
    return [];
  }

  // Apply hard filters
  let candidates = BREED_DATABASE;

  if (profile.allergies === true) {
    candidates = candidates.filter((breed) => breed.traits.hypoallergenic);
  }

  if (profile.familyComposition === 'young-kids') {
    candidates = candidates.filter((breed) => breed.traits.goodWithKids);
  }

  // Score each candidate
  const scored = candidates.map((breed) => {
    const results = [
      scoreMusicPreference(profile, breed),
      scoreActivityLevel(profile, breed),
      scoreLivingSpace(profile, breed),
      scoreGrooming(profile, breed),
      scoreFamilyComposition(profile, breed),
    ];

    const score = results.reduce((sum, result) => sum + result.score, 0);
    const reasons = results.filter((result) => result.reason).map((result) => result.reason as string);

    const reasoning = reasons.length > 0
      ? reasons.join('; ')
      : 'General compatibility based on temperament';

    return {
      breed: breed.name,
      matchScore: Math.max(0, Math.min(100, score)), // Clamp to 0-100
      reasoning,
    };
  });

  // Sort by score descending and return top 3
  return scored
    .toSorted((a, b) => b.matchScore - a.matchScore)
    .slice(0, 3);
}
