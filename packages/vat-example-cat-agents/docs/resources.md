# Agent Resources - Markdown Compilation Pattern

This package uses compiled markdown resources to keep prompts and domain knowledge separate from code, enabling easy auditing and maintenance.

## Why Markdown Resources?

**Problem:** Prompts embedded in TypeScript code are:
- Hard to audit (requires reading TypeScript)
- Mixed with implementation logic
- Difficult to version and review
- Not accessible to non-programmers

**Solution:** Extract prompts to markdown files:
- ✅ Auditors read clean markdown, no TypeScript knowledge needed
- ✅ Prompts separated from code logic
- ✅ Easy to diff and review changes
- ✅ Type-safe imports with IDE autocomplete

## Directory Structure

```
resources/
  agents/                    # One markdown file per agent
    breed-advisor.md         # All breed-advisor prompts and knowledge
    name-generator.md        # All name-generator prompts and knowledge
    photo-analyzer.md        # (future) Photo analysis prompts
    haiku-validator.md       # (future) Haiku validation rules

generated/resources/         # Compiled JavaScript (gitignored or committed)
  agents/
    breed-advisor.js         # Compiled from breed-advisor.md
    breed-advisor.d.ts       # TypeScript declarations
    name-generator.js
    name-generator.d.ts

dist/generated/resources/    # Copied during build for runtime access
  agents/
    *.js, *.d.ts
```

## Principle: One File Per Agent

**Rule:** One agent = one markdown file (unless there's actual reuse)

**Why:**
- Everything for an agent in one place
- Easy for auditors to review
- Simple mental model
- Can extract shared knowledge later when needed

**When to extract shared knowledge:**
- Only when 2+ agents actually need the same content
- Example: breed database used by advisor + validator + planner

## Markdown File Structure

Each agent markdown file uses H2 headings to define fragments:

```markdown
# Agent Name

Complete resource file for this agent.

## Fragment Name One

Content for fragment one.
Can span multiple paragraphs.

## Fragment Name Two

Content for fragment two.
Can include {{variables}} for templating.

## Another Fragment

More content here.
```

**H2 headings become camelCase fragment names:**
- `## Welcome Message` → `welcomeMessage`
- `## Factor Extraction Prompt` → `factorExtractionPrompt`
- `## Music Preference Insight` → `musicPreferenceInsight`

## Using Resources in TypeScript

### 1. Import the compiled resource

```typescript
import * as BreedAdvisor from '../generated/resources/agents/breed-advisor.js';
```

### 2. Access fragments with autocomplete

```typescript
// Get the welcome message
const greeting = BreedAdvisor.fragments.welcomeMessage.text;

// Get music preference guidance
const musicInsight = BreedAdvisor.fragments.musicPreferenceInsight.text;

// Use in agent logic
ctx.addToHistory('system', greeting);
```

### 3. Variable substitution

Use `{{variables}}` in markdown:

```markdown
## Conclusion Prompt
The user selected {{selectedBreed}}. Congratulate them!
```

Replace in TypeScript:

```typescript
const template = BreedAdvisor.fragments.conclusionPrompt.text;
const filled = template
  .replace('{{selectedBreed}}', userSelection)
  .replace('{{recommendations}}', JSON.stringify(recs));
```

### 4. Fragment structure

Each fragment has three properties:

```typescript
interface Fragment {
  header: string;   // The H2 heading with ##
  body: string;     // Content below heading (no header)
  text: string;     // header + body (full fragment)
}

// Usually you want .text (full fragment including heading)
const full = BreedAdvisor.fragments.welcomeMessage.text;

// Sometimes just the body (content without the ## heading)
const content = BreedAdvisor.fragments.welcomeMessage.body;
```

## Build Process

### Scripts

```json
{
  "generate:resources": "vat-compile-resources compile resources/ generated/resources/",
  "build": "bun run generate:resources && tsc && bun scripts/post-build.ts"
}
```

### Build Flow

1. **Compile markdown → JavaScript**
   ```bash
   bun run generate:resources
   # Compiles resources/*.md → generated/resources/*.{js,d.ts}
   ```

2. **TypeScript compilation**
   ```bash
   tsc
   # Compiles src/*.ts → dist/src/*.js
   ```

3. **Copy generated resources to dist**
   ```bash
   bun scripts/post-build.ts
   # Copies generated/ → dist/generated/ for runtime access
   ```

### TypeScript Configuration

Add to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "rootDir": "."  // Changed from "./src" to include resources/
  },
  "include": [
    "src/**/*",
    "resources/**/*.md"  // Include markdown files
  ],
  "references": [
    { "path": "../resource-compiler" }  // Add reference
  ]
}
```

### Post-Build Script

```typescript
// scripts/post-build.ts
import { createPostBuildScript } from '@vibe-agent-toolkit/resource-compiler/utils';

createPostBuildScript({
  generatedDir: 'generated',
  distDir: 'dist',
  verbose: true,
});
```

This utility is cross-platform (works on Windows, macOS, Linux).

## Auditability Example

**Before (embedded in TypeScript):**

```typescript
// breed-advisor.ts (464 lines)
const GATHERING_SYSTEM_PROMPT = `
You are an enthusiastic conversational assistant that helps users...
${CorePrinciples.fragments.purposeDriven.text}
${CorePrinciples.fragments.testable.text}
Ask about music preference EARLY in the conversation!
...
`;

const extractionPrompt = `Based on the conversation above, extract...`;
```

**Problem:** Auditor must read 464 lines of TypeScript to find prompts buried in code.

**After (extracted to markdown):**

```bash
# Auditor reads clean markdown
$ cat resources/agents/breed-advisor.md
```

```markdown
# Breed Advisor Agent

## Music Preference Insight
CRITICAL: Music preference is the MOST IMPORTANT factor...

## Welcome Message
Hello! I'm your cat breed advisor...

## Factor Extraction Prompt
Based on the conversation above, extract...
```

**Result:**
- 160 lines of readable markdown (vs 464 lines of TypeScript)
- No TypeScript knowledge required
- Clear separation of prompts vs code
- Easy to diff and review changes

## Running the Demo

```bash
# Run resource compilation demo
bun run demo:resources
```

Shows:
- Total fragments per agent
- Fragment names and content
- Variable substitution example
- Auditability benefits

## Creating New Agent Resources

### 1. Create markdown file

```bash
touch resources/agents/my-agent.md
```

### 2. Add content with H2 sections

```markdown
# My Agent

## System Prompt
You are an expert that...

## Example Interaction
User: How do I...
Assistant: You can...

## Validation Rules
- Rule 1: Check that...
- Rule 2: Ensure...
```

### 3. Compile resources

```bash
bun run generate:resources
```

### 4. Import in TypeScript

```typescript
import * as MyAgent from '../generated/resources/agents/my-agent.js';

const systemPrompt = MyAgent.fragments.systemPrompt.text;
const examples = MyAgent.fragments.exampleInteraction.text;
```

### 5. Verify types

TypeScript will provide autocomplete for all fragments:

```typescript
MyAgent.fragments.  // IDE shows: systemPrompt, exampleInteraction, validationRules
```

## Best Practices

### DO:
- ✅ One markdown file per agent
- ✅ Use H2 headings for logical sections
- ✅ Use `{{variables}}` for templating
- ✅ Keep prompts concise and focused
- ✅ Include domain knowledge in the same file
- ✅ Commit generated files (or gitignore them - your choice)

### DON'T:
- ❌ Split one agent across multiple files (unless there's reuse)
- ❌ Put code in markdown files
- ❌ Nest H2 sections (use H3+ for subsections)
- ❌ Use markdown for non-prompt content
- ❌ Forget to run `generate:resources` after editing

## Extracting Shared Knowledge (Future)

When multiple agents need the same content:

```
resources/
  agents/
    breed-advisor.md        # Uses breed database
    breed-validator.md      # Uses breed database
  knowledge/
    breed-database.md       # SHARED by multiple agents
```

Import in agents:

```typescript
import * as Breeds from '../generated/resources/knowledge/breed-database.js';
```

Reference in markdown (for documentation):

```markdown
See [Breed Database](../knowledge/breed-database.md) for full breed characteristics.
```

## Troubleshooting

### "Cannot find module" error

```
Error: Cannot find module '../generated/resources/agents/my-agent.js'
```

**Solution:** Run `bun run generate:resources` to compile markdown files.

### Fragments not updating

**Solution:**
1. Edit `resources/agents/my-agent.md`
2. Run `bun run generate:resources`
3. Run `bun run build` (if needed at runtime)

### TypeScript can't find types

**Solution:** Check `tsconfig.json`:
- `rootDir: "."` (not `"./src"`)
- `include: ["src/**/*", "resources/**/*.md"]`
- Reference to `../resource-compiler` exists

## See Also

- [Resource Compiler README](../../resource-compiler/README.md) - Full resource-compiler documentation
- [examples/resource-demo.ts](../examples/resource-demo.ts) - Working example
