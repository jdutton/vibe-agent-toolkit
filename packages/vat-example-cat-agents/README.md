# @vibe-agent-toolkit/vat-example-cat-agents

Example agents demonstrating VAT patterns through 8 quirky cat personalities.

## Purpose

This package implements cat-themed agents as a **code-first exploration** to discover the right abstractions for the Vibe Agent Toolkit. By building real, working agents first, we let the code tell us what the `vat.*` API should look like.

## Package Structure

**Quick Navigation:**
- **Source Code**: `src/` - Agent implementations organized by archetype
- **Tests**: `test/` - Unit and integration tests with fixtures
- **Demos**: `examples/` - Executable examples (see [Running Demos](#running-demos))
- **Utilities**: `scripts/` - Build-time tools (image processing, etc.)

See [STRUCTURE.md](./STRUCTURE.md) for complete details on package organization.

**Other Demos:**
- Runtime adapter demos (Vercel AI SDK, LangChain, etc.) are in `packages/runtime-*/examples/`
- Those demos use cat agents to show cross-framework portability

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

## Running Demos

### Photo Analysis Demo

Demonstrates the photo analyzer agent with actual test fixture images:

```bash
bun run demo:photos
```

**What it does:**
- Loads 4 cat photos + 2 not-cat photos (bear, robot) from `test/fixtures/photos/`
- Analyzes each photo using **MOCK MODE** (EXIF metadata + filename patterns)
- Displays extracted characteristics
- Shows clear warning that it's not analyzing actual pixels

**Mock Mode vs Real Vision API:**
- **MOCK MODE** (default): Extracts from EXIF metadata and filename patterns. Fast, free, deterministic. Does NOT analyze actual pixels.
- **REAL MODE** (future): Set `USE_REAL_VISION=true` to call actual vision API (Claude Vision, GPT-4 Vision). Slow, costs money, analyzes actual pixels.

The demo makes it crystal clear which mode is active to avoid confusion about what's mocked.

### Runtime Adapter Demos

To see cat agents used across different frameworks:

```bash
# Vercel AI SDK demo
cd packages/runtime-vercel-ai-sdk
bun run demo

# LangChain demo
cd packages/runtime-langchain
bun run demo

# OpenAI SDK demo
cd packages/runtime-openai
bun run demo

# Claude Agent SDK demo
cd packages/runtime-claude-agent-sdk
bun run demo
```

These demos show the SAME cat agents (haiku validator, name validator, etc.) working across different runtimes, demonstrating portability.

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

## Test Fixtures: Processing Cat Photos

This package includes a utility for processing cat photos into git-friendly test fixtures with embedded metadata.

### Image Processing Strategy

**Why EXIF metadata?**
- Embeds test expectations directly in image files
- Enables realistic testing with actual images (not just filenames)
- Later supports comparing vision API output vs ground truth
- Self-documenting test fixtures

### Image Specifications

- **Format**: Progressive JPEG, PNG, or WebP
- **Resolution**: 512px wide (maintains aspect ratio)
- **File Size**: Target ~50-100KB per image
- **Metadata**: Structured test data in EXIF Description field

### Processing Images

1. **Download images** from Unsplash (free license) to a local directory
2. **Process images** with the dev-tools utility:

```bash
# From repo root
cd packages/dev-tools
bun run process-images ~/Downloads/cat-photos ../../vat-example-cat-agents/test/fixtures/photos/cats
```

The script will:
- Resize images to 512px wide
- Compress to target file size
- Extract metadata from filename patterns
- Write structured metadata to EXIF Description field
- Report file sizes and warnings

### Filename Patterns for Auto-Detection

The script intelligently extracts metadata from filenames:

**Colors**: `orange`, `black`, `white`, `gray`, `calico`
**Patterns**: `tabby`, `solid`, `patched`, `striped`
**Sizes**: `tiny`, `small`, `large` (defaults to `medium`)
**Breeds**: `persian`, `maine-coon`, `siamese`, `domestic-shorthair`
**Personality**: `playful`, `lazy`, `grumpy`, `affectionate`, `curious`, `regal`
**Quirks**: `three-leg`, `cross-eye`, `scar`

**Examples**:
- `orange-tabby-playful.jpg` → Orange tabby, playful personality
- `black-cat-large.jpg` → Black cat, large size
- `calico-patched-three-leg.jpg` → Calico patched, three-legged quirk

### Test Fixture Directory Structure

```
test/fixtures/photos/
├── cats/                           # Valid cat photos
│   ├── orange-tabby-playful.jpg   # Standard domestic cat
│   ├── black-cat-mysterious.jpg   # Different color variant
│   ├── calico-patched.png         # PNG format test
│   ├── maine-coon-large.webp      # WebP format test
│   └── three-legged-warrior.jpg   # Edge case with quirks
├── not-cats/                       # Negative test cases
│   └── dog-golden-retriever.jpg   # Should be rejected
└── cat-like/                       # Ambiguous cases
    └── stuffed-animal-cat.jpg     # Tests edge detection
```

### EXIF Metadata Format

The script writes JSON metadata to the EXIF Description field:

```json
{
  "furColor": "Orange",
  "furPattern": "Tabby",
  "eyeColor": "Green",
  "breed": "Domestic Shorthair",
  "size": "medium",
  "personality": ["Playful", "Curious"],
  "quirks": ["Three-legged"],
  "notes": "Additional test notes",
  "expectedCategory": "cat"
}
```

### Reading EXIF Metadata in Tests

Update the photo analyzer to read EXIF metadata for mocking:

```typescript
import sharp from 'sharp';

// Read EXIF metadata from image
const metadata = await sharp(imagePath).metadata();
const exifDescription = metadata.exif?.ImageDescription;

if (exifDescription) {
  const testData = JSON.parse(exifDescription);
  // Use testData for mock expectations
}
```

### Supported Formats

- **JPEG** (.jpg, .jpeg): Progressive, MozJPEG compression, 82% quality
- **PNG** (.png): Progressive, level 6 compression
- **WebP** (.webp): 80% quality

All formats support EXIF metadata embedding.

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
