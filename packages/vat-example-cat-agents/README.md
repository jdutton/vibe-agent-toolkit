# @vibe-agent-toolkit/vat-example-cat-agents

Example agents demonstrating VAT patterns through 8 quirky cat personalities.

## Purpose

This package implements cat-themed agents as a **code-first exploration** to discover the right abstractions for the Vibe Agent Toolkit. By building real, working agents first, we let the code tell us what the `vat.*` API should look like.

## The 8 Cat Agents

1. **Professor Whiskers** - Haiku validation specialist (strict syllable counter)
2. **Madam Fluffington** - Cat naming authority (extremely judgmental)
3. **Sir Pounce-a-lot** - Code smell detective (finds redundancy)
4. **Captain Keyboard** - Typing quirk analyzer (detects patterns)
5. **Midnight Oracle** - Cryptic fortune teller (mysterious predictions)
6. **Sergeant Scheduler** - Meeting efficiency analyzer (no-nonsense)
7. **Lady Loaf** - Resting pose classifier (expert on cat positions)
8. **DJ Purrito** - Music/vibe curator (creates playlists)

## Current Status

**Implemented:**
- ✅ Core schemas (CatCharacteristics, Haiku, Names, Validation results)
- ✅ Professor Whiskers (haiku-validator.ts) - syllable validation with kigo/kireji detection
- ✅ Madam Fluffington (name-validator.ts) - characteristic-based name validation

**Next Steps:**
- Implement remaining 6 agents
- Discover common patterns
- Design the `vat.*` framework based on what we learn

## Installation

```bash
npm install @vibe-agent-toolkit/vat-example-cat-agents
```

## Usage

### Professor Whiskers - Haiku Validator

```typescript
import { validateHaiku, critiqueHaiku, type Haiku } from '@vibe-agent-toolkit/vat-example-cat-agents';

const haiku: Haiku = {
  line1: 'Autumn moon rises',
  line2: 'Silver light on quiet waves',
  line3: 'The cat sits and waits',
};

const result = validateHaiku(haiku);
console.log(result);
// {
//   valid: true,
//   syllables: { line1: 5, line2: 7, line3: 5 },
//   errors: [],
//   hasKigo: true,
//   hasKireji: false
// }

const critique = critiqueHaiku(haiku);
console.log(critique);
// === Professor Whiskers' Haiku Critique ===
// ✓ Syllable structure is IMPECCABLE. 5-7-5, as it should be.
// ...
```

### Madam Fluffington - Name Validator

```typescript
import {
  validateCatName,
  critiqueCatName,
  type CatCharacteristics
} from '@vibe-agent-toolkit/vat-example-cat-agents';

const cat: CatCharacteristics = {
  physical: {
    furColor: 'Orange',
    furPattern: 'Tabby',
    eyeColor: 'Green',
    size: 'large',
  },
  behavioral: {
    personality: ['Regal', 'Demanding', 'Affectionate'],
  },
  description: 'A large orange tabby with green eyes who rules the household',
};

const result = validateCatName('Duke Marmalade III', cat);
console.log(result);
// {
//   status: 'valid',
//   reason: '*purrs approvingly* "Duke Marmalade III"! Proper masculine nobility! You have excellent taste!'
// }

const critique = critiqueCatName('Fluffy', cat);
console.log(critique);
// === Madam Fluffington's Naming Critique ===
// *adjusts diamond collar and regards you with piercing blue eyes*
// ...
// Verdict: INVALID
// *flicks tail disdainfully* "Fluffy"? Far too common and beneath any respectable feline.
```

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun run test

# Type check
bun run typecheck

# Lint
bun run lint
```

## Architecture

Each agent is implemented as **plain TypeScript functions** without framework dependencies. This lets us:

1. Build real, working code first
2. Discover common patterns organically
3. Design the `vat.*` API based on actual needs
4. Keep agents simple and testable

Once we've implemented several agents, we'll extract common patterns into the framework.

## Contributing

This is a code-first exploration. Each agent is implemented as plain TypeScript to discover common patterns before building the framework.

## License

MIT
