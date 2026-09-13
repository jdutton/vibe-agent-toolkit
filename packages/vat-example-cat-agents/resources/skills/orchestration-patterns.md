# Advanced Orchestration Patterns and CLI Integration

Reference material for [SKILL.md](./SKILL.md). Read this when you need the parallel,
conditional and checkpointed orchestration shapes, or a worked CLI request/response pair.

## Advanced Orchestration Patterns

### Pattern: Parallel Execution

When agents don't depend on each other, run them in parallel.

**Example:** Generate both name and haiku from same characteristics

```typescript
const [name, haiku] = await Promise.all([
  generateCatName(characteristics),
  generateCatHaiku(characteristics),
]);
```

**Benefits:** Faster execution, better user experience

### Pattern: Fallback Chain

When one agent fails, try alternatives.

**Example:** Photo analysis with text description fallback

```typescript
let characteristics;
try {
  characteristics = await analyzePhoto(imagePath);
} catch {
  // Fallback to text description
  const description = await getUserDescription();
  characteristics = await parseDescription(description);
}
```

**Benefits:** Resilience, better error handling

### Pattern: Conditional Routing

Choose agent path based on user input type.

**Example:** Multi-modal input handling

```typescript
if (input.type === 'image') {
  characteristics = await analyzePhoto(input.imagePath);
} else if (input.type === 'text') {
  characteristics = await parseDescription(input.description);
} else {
  // Conversational gathering
  characteristics = await breedAdvisor.gather();
}
```

**Benefits:** Flexible input handling, better UX

### Pattern: Staged Approval

Break complex workflows into approval stages.

**Example:** Multi-stage breeding application

```typescript
// Stage 1: Basic info approval
const basicApproval = await humanApproval({ stage: 'basic', data });
if (!basicApproval.approved) return;

// Stage 2: Detailed questionnaire
const detailApproval = await humanApproval({ stage: 'detail', data });
if (!detailApproval.approved) return;

// Stage 3: Final review
const finalApproval = await humanApproval({ stage: 'final', data });
```

**Benefits:** Checkpoints prevent wasted work, clearer decision points

## CLI Integration Examples

### Example 1: Validate Name via CLI

```bash
# Input
echo '{
  "name": "Mr. Whiskers",
  "characteristics": {
    "physical": {
      "furColor": "Orange",
      "furPattern": "Tabby",
      "size": "medium"
    },
    "behavioral": {
      "personality": ["Playful", "Curious"]
    }
  }
}' | vat agents validate-name

# Output (stdout)
{
  "status": "valid",
  "reason": "Name meets all quirky validation rules",
  "confidence": 0.95
}
---
# (stderr - empty if no errors)
```

### Example 2: Validate Haiku via CLI

```bash
# Input
echo '{
  "lines": [
    "Orange sunset fur",
    "Paws dance across the tatami",
    "Zen master purrs"
  ]
}' | vat agents validate-haiku

# Output (stdout)
{
  "status": "valid",
  "syllableCounts": [5, 7, 5],
  "hasKigo": true,
  "kigo": "sunset",
  "hasKireji": false,
  "errors": []
}
---
# (stderr - empty if no errors)
```

### Example 3: Error Handling

```bash
# Invalid input
echo '{"invalid": "schema"}' | vat agents validate-name

# Output
# (stdout - empty)
---
Error: Invalid input schema. Expected 'name' and 'characteristics' fields.
Schema validation failed:
  - Missing required field: name
  - Missing required field: characteristics
# (exit code: 2)
```

## Next Steps

Once you've successfully orchestrated agents:

1. **Explore Combinations** - Try chaining agents in new ways
2. **Add Custom Validation** - Create your own quirky validation rules
3. **Build New Workflows** - Combine agents for complex use cases
4. **Contribute Patterns** - Share successful orchestration strategies
5. **Package Skills** - Create distributable skill packages with pure functions

## Questions?

- **For orchestration patterns:** This file (SKILL.md)
- **For agent-specific details:** See individual agent resources
- **For implementation examples:** See examples/ directory
- **For archetype theory:** See package README.md
