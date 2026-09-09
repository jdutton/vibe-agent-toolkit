# Detailed Workflow Orchestration

Reference material for [SKILL.md](./SKILL.md). Read this when you are implementing an
orchestration end to end rather than choosing between the high-level patterns.

## Detailed Workflow Orchestration

### Workflow A: Breed Selection (Conversational)

**When:** User wants help finding the right cat breed.

**Agent:** [breed-advisor](../agents/breed-advisor.md)

**Orchestration strategy:**
1. **Phase 1 - Gathering** (see [Conversation Strategy](../agents/breed-advisor.md#conversation-strategy))
   - Collect ≥4 factors including music preference
   - ONE question at a time (don't bombard)
   - Extract factors after each turn
   - Monitor readiness: `factorsCollected >= 4 && musicPreference != null`

2. **Phase 2 - Recommendation**
   - Present 3-5 matched breeds
   - Allow exploration, questions, comparisons
   - Use conversational formatting (not data dump)

3. **Phase 3 - Selection**
   - Detect selection signals ("I'll take", "sounds good")
   - Conclude gracefully
   - Provide next steps or exit instruction

**Critical factor:** Music preference is the PRIMARY compatibility factor. Ask early, use as conversation anchor. See [Music Preference Insight](../agents/breed-advisor.md#music-preference-insight) for mappings.

**Reference implementation:** See [cat-breed-selection.md](./cat-breed-selection.md) for detailed breed selection orchestration.

### Workflow B: Photo Analysis Pipeline

**When:** User provides a cat photo and wants analysis, name, or haiku.

**Agents:** [photo-analyzer](../agents/photo-analyzer.md) → [name-generator](../agents/name-generator.md) OR [haiku-generator](../agents/haiku-generator.md)

**Orchestration strategy:**

```
Step 1: Analyze Photo
- Input: Image path/URL
- Agent: photo-analyzer
- Output: CatCharacteristics
- Note: Supports mock mode (reads EXIF) for testing

Step 2: Generate Content
- Input: CatCharacteristics from Step 1
- Agent: name-generator OR haiku-generator
- Output: NameSuggestion OR Haiku

Optional Step 3: Validate
- Input: Generated content + original characteristics
- Agent: name-validator OR haiku-validator (pure functions)
- Output: Validation result
- If invalid: Retry Step 2 with feedback
```

**Mockable behavior:** photo-analyzer reads EXIF metadata in mock mode. For production, set `mockable: false` to use real vision API.

### Workflow C: Text Description Pipeline

**When:** User describes a cat in text (no photo).

**Agents:** [description-parser](../agents/description-parser.md) → [name-generator](../agents/name-generator.md) OR [haiku-generator](../agents/haiku-generator.md)

**Orchestration strategy:**

```
Step 1: Parse Description
- Input: Text description
- Agent: description-parser
- Output: CatCharacteristics (same schema as photo-analyzer!)

Step 2-3: Same as Workflow B
- Multi-modal convergence: photo and text produce same schema
- Downstream agents (name-gen, haiku-gen) work with either
```

**Key insight:** Photo and text paths converge at `CatCharacteristics` schema. This enables multi-modal workflows without agent changes.

### Workflow D: Generate-Validate-Retry Loop

**When:** Generator produces content that must pass validation rules.

**Pattern:** Generator (LLM) + Validator (pure function) + Retry logic

**Implementation:**

```typescript
// Pseudo-code for orchestration
let attempts = 0;
const maxAttempts = 3;

while (attempts < maxAttempts) {
  // Generate content
  const suggestion = await generator(characteristics);

  // Validate (pure function, instant)
  const validation = validator(suggestion, characteristics);

  if (validation.status === 'valid') {
    return suggestion; // Success!
  }

  // Retry with feedback
  attempts++;
  // Optional: Adjust approach based on validation.reason
}

throw new Error('Could not generate valid content after 3 attempts');
```

**Why this pattern works:**
- Generator has NO knowledge of validation rules (isolated concerns)
- Validator is deterministic (pure function, fast)
- Feedback loop tests multi-turn orchestration
- ~60-70% initial rejection rate forces iteration

**Agents using this pattern:**
- [name-generator](../agents/name-generator.md) + name-validator
- [haiku-generator](../agents/haiku-generator.md) + haiku-validator

### Workflow E: HITL Approval Gate

**When:** Decision requires human judgment (compliance, taste, ethics).

**Agent:** [human-approval](../agents/human-approval.md)

**Orchestration strategy:**

```
Step 1: Prepare Request
- Gather all necessary context
- Format clearly for human reviewer
- Include relevant data (characteristics, generated content, reasoning)

Step 2: Emit Approval Request
- Agent: human-approval
- Input: Request payload
- Behavior: Blocks waiting for response
- Timeout: Configurable (default: 60s)

Step 3: Handle Response
- Approved: Continue workflow
- Rejected: Handle gracefully (retry, inform user, etc.)
- Timeout: Fall back to safe default or escalate
```

**Mockable behavior:** Set `mockable: true` to auto-approve without human (useful for testing).

**Real-world uses:**
- Breeding application approval
- Name selection from alternatives
- Content moderation decisions
