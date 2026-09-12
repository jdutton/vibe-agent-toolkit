---
name: vat-example-cat-agents
description: Comprehensive orchestration guide for Claude Code using the
  vat-example-cat-agents toolkit
---

# VAT Example Cat Agents

Comprehensive orchestration guide for Claude Code using the vat-example-cat-agents toolkit.

## Purpose: For Claude Code, Not the LLM

**Key distinction:**
- **This file** = Guidance for Claude Code (how to orchestrate agents)
- **Agent resources** = Content for the LLM (what to say/know)

This skill references agent resources via markdown links but doesn't duplicate LLM prompts.

## Agent Inventory

The vat-example-cat-agents package provides 8 agents across 4 archetypes:

### Pure Function Tools (2 agents)
- **haiku-validator** - Validates 5-7-5 syllable structure + kigo/kireji
- **name-validator** - Quirky characteristic-based validation

### One-Shot LLM Analyzers (4 agents)
- **photo-analyzer** - Vision LLM extracts characteristics from images
- **description-parser** - Text parsing extracts characteristics from descriptions
- **name-generator** - Creates characteristic-based cat names
- **haiku-generator** - Composes haikus about cats

### Conversational Assistant (1 agent)
- **breed-advisor** - Multi-turn breed selection through natural dialogue

### External Event Integrator (1 agent)
- **human-approval** - HITL approval gate (mockable)

## When to Use This Skill

Trigger this skill when:
- User wants help selecting a cat breed
- User has a cat photo and wants analysis
- User needs a cat name suggestion
- User wants a haiku about their cat
- User needs validation of generated content (names, haikus)
- User wants to combine multiple agents in a workflow

## High-Level Orchestration Patterns

### Pattern 1: Single Agent (Simple)

Use when user has a straightforward request that maps to one agent.

**Example workflows:**
- "What cat breed should I get?" → breed-advisor
- "Analyze this cat photo" → photo-analyzer
- "Is this a valid haiku?" → haiku-validator (pure function)

### Pattern 2: Sequential Pipeline (Multi-Agent)

Use when output of one agent feeds into another.

**Example workflows:**
1. Photo → Characteristics → Name
   - photo-analyzer → name-generator
2. Photo → Characteristics → Haiku
   - photo-analyzer → haiku-generator
3. Description → Characteristics → Name → Validation
   - description-parser → name-generator → name-validator

### Pattern 3: Generate-Validate Loop (Iterative)

Use when generator produces content that needs validation with retry logic.

**Example workflows:**
1. Name generation with validation
   - Generate → Validate → If invalid, retry with feedback
   - Uses: name-generator + name-validator
2. Haiku generation with validation
   - Generate → Validate → If invalid, retry
   - Uses: haiku-generator + haiku-validator

**Orchestration tip:** Generator agents have NO knowledge of validation rules. This is intentional - forces iteration and tests feedback loops.

### Pattern 4: HITL Approval Gate (External Event)

Use when decision requires human judgment.

**Example workflows:**
1. Breed application approval
   - Gather info → Generate application → human-approval → Process result
2. Name approval before finalization
   - Generate names → Present options → Human selects → Finalize

## Detailed Workflow Orchestration

Step-by-step orchestration for each archetype — inputs, hand-offs and failure handling — is in
[workflow-orchestration.md](resources/workflow-orchestration.md).

## CLI Exposure for Pure Functions

Pure function tools (validators) can be exposed via CLI for direct invocation.

### Usage Pattern

```bash
# Pass JSON input, get JSON/YAML output
echo '{"name": "Mr. Whiskers", "characteristics": {...}}' | vat agents validate-name

# Output format (using 2>&1):
# [stdout - complete output]
# ---
# [stderr - error messages]
```

### Implementation Requirements

1. **Input:** JSON on stdin
2. **Output:** JSON or YAML on stdout (complete, flushed)
3. **Errors:** stderr (separated with `---` when using `2>&1`)
4. **Exit codes:** 0 = success, 1 = validation failure, 2 = error

### Sequence Example

```
[Start]
↓
Read stdin (JSON input)
↓
Parse and validate input schema
↓
Execute pure function
↓
Flush stdout with complete result
↓
Print "---" separator
↓
Flush stderr with any error messages
↓
Exit with appropriate code
```

### Benefits

- MCP can map to CLI calls (fast, stateless)
- No long-running processes for pure functions
- Clear separation of output vs errors
- Composable with other CLI tools

### Applicable Agents

- **name-validator** - `vat agents validate-name`
- **haiku-validator** - `vat agents validate-haiku`
- Future: Any pure function tool

## What Claude Code Does vs What Agents Do

### Claude Code's Role (This Skill):

**Orchestration:**
- Select which agent(s) to use
- Chain agents in workflows (pipelines)
- Manage state between agents (pass outputs as inputs)
- Handle retries and error recovery

**Monitoring:**
- Track conversation phase (gathering, recommendation, selection)
- Count validation attempts (retry limits)
- Detect completion signals (phase transitions)
- Monitor timeouts (HITL approvals)

**Decision Making:**
- When to transition between phases
- When to retry vs give up
- Which agent path to take (photo vs text)
- How to present results to user

### Agents' Role (Agent Resources):

**Pure Functions:**
- Execute deterministic logic (validation rules)
- Return results instantly
- No side effects, no state

**LLM Analyzers:**
- Extract structured data from unstructured input
- Apply domain knowledge to classification
- Generate creative content (names, haikus)

**Conversational Assistants:**
- Conduct natural dialogue
- Accumulate context over turns
- Make recommendations based on collected factors

**Event Integrators:**
- Emit events to external systems
- Block waiting for responses
- Handle timeouts and errors

**Key insight:** Agents are specialized, focused on their domain. Claude Code provides the glue, orchestration, and workflow logic.

## Content Separation Guidelines

### What Belongs in Agent Resources (LLM-Facing):

✅ System prompts and LLM instructions
✅ Domain knowledge (breed database, syllable counting rules, kigo lists)
✅ Extraction formats (JSON schemas, output templates)
✅ Examples for few-shot learning
✅ Natural language mappings
✅ Validation rules and constraints

**Location:** `resources/agents/*.md`

### What Belongs in Skills (Claude Code-Facing):

✅ When to trigger agents (user intent signals)
✅ How to chain agents (workflow patterns)
✅ What to monitor (readiness criteria, retry limits)
✅ Debugging guidance (common issues, pitfalls)
✅ Meta-strategy (why photo first, when to retry)
✅ CLI exposure patterns

**Location:** `resources/skills/*.md` (this file)

### Overlap (Reference, Don't Duplicate):

⚠️ Workflow structure (skill explains orchestration, agent implements)
⚠️ Phase transitions (skill monitors, agent executes)
⚠️ Validation criteria (skill manages retries, agent defines rules)

**Resolution:** Keep agent resources authoritative. Skills REFERENCE via links, don't duplicate.

## Common Pitfalls

### ❌ Don't: Call Agents Without Understanding Their Archetype

Each archetype has different behavior:
- Pure functions: Instant, deterministic
- LLM analyzers: Single call, non-deterministic
- Conversational: Multi-turn, stateful
- Event integrators: Blocking, timeout handling

### ✅ Do: Match Orchestration to Archetype

```
Pure function → Call directly, no retry needed
LLM analyzer → Call once, parse result
Conversational → Multi-turn loop with state
Event integrator → Emit, wait, handle timeout
```

### ❌ Don't: Skip Validation in Generate-Validate Loops

Validators exist for a reason. Don't bypass them or assume LLM output is always valid.

### ✅ Do: Embrace the Feedback Loop

```
Generate → Validate → If invalid, retry with feedback
```

This pattern tests real-world orchestration where first attempts often fail.

### ❌ Don't: Mix Mock and Production Modes Accidentally

Mock mode (EXIF metadata) is fast and free. Production mode (real APIs) is slow and expensive. Be explicit about which mode you're using.

### ✅ Do: Use Mock Mode for Development, Production for Deployment

```typescript
// Development/testing
const result = await analyzePhoto(path, { mockable: true });

// Production
const result = await analyzePhoto(path, { mockable: false });
```

### ❌ Don't: Bombard Users with Questions in Conversational Flows

One question at a time. Give users space to think and respond naturally.

### ✅ Do: Guide Conversation Gently

```
Bad: "Tell me your music, living space, activity level, grooming, family, and allergies"
Good: "What's your favorite type of music?" → [response] → "Great! Tell me about your living space..."
```

## Debugging: When Things Go Wrong

### Issue: Photo Analysis Fails

**Symptoms:** Vision API errors, unexpected characteristics

**Debug steps:**
1. Check if image path is valid
2. Verify image is actually a photo (not text, PDF, etc.)
3. Try mock mode first: `{ mockable: true }`
4. Check API key and rate limits for production mode
5. Verify EXIF metadata format if using mock mode

### Issue: Name Validation Always Fails

**Symptoms:** Name generator can't produce valid names after 3+ attempts

**Debug steps:**
1. Check validation rules: name-validator has quirky requirements
2. Review characteristics: Validation rules depend on cat traits
3. Verify characteristics schema: All required fields present?
4. Check feedback loop: Is validation.reason being used for retries?

**Common cause:** ~60-70% rejection rate is EXPECTED. This forces iteration and tests feedback loops.

### Issue: Haiku Validation Rejects Everything

**Symptoms:** Haiku generator struggles to meet 5-7-5 syllable structure

**Debug steps:**
1. Check syllable counting algorithm: May differ from LLM's internal counting
2. Verify kigo (seasonal word) presence: Required for valid haiku
3. Check kireji (cutting word) detection: Optional but improves score
4. Review haiku format: Must be exactly 3 lines

**Solution:** Allow multiple retry attempts (3-5). Haiku generation is hard.

### Issue: Conversation Stalls in Breed Selection

**Symptoms:** Agent doesn't transition to recommendations

**Debug steps:**
1. Check factor count: Need ≥4 factors collected
2. Verify music preference: REQUIRED for transition
3. Review conversation history: Are factors being extracted?
4. Check readiness criteria: Session state vs actual factors

**Solution:** Ensure extraction happens after each turn. Monitor `factorsCollected` metadata.

### Issue: HITL Approval Times Out

**Symptoms:** human-approval agent returns timeout status

**Debug steps:**
1. Check timeout value: Default 60s, may need adjustment
2. Verify event emission: Is request actually sent?
3. Check mock mode: Set `mockable: true` for testing
4. Review request format: Is it clear what needs approval?

**Solution:** For testing, use mock mode. For production, increase timeout or add retry logic.

## Agent Resource Links

### Pure Function Tools
- name-validator (no agent resource - pure TypeScript logic)
- haiku-validator (no agent resource - pure TypeScript logic)

### One-Shot LLM Analyzers
- Photo Analyzer - Vision analysis
- Description Parser - Text parsing
- Name Generator - Creative naming
- Haiku Generator - Haiku composition

### Conversational Assistant
- Breed Advisor - Multi-turn breed selection
  - Welcome Message
  - Music Preference Insight
  - Factor Definitions
  - Conversation Strategy
  - Factor Extraction Prompt
  - Transition Message
  - Recommendation Presentation
  - Selection Extraction
  - Conclusion Prompt

### External Event Integrator
- Human Approval - HITL approval gate

### Related Documentation
- [Cat Breed Selection Skill](resources/cat-breed-selection.md) - Detailed breed advisor orchestration

## Success Criteria

Your orchestration is successful when:

**For Single Agents:**
- Agent called with valid input schema
- Output parsed and validated correctly
- Errors handled gracefully
- User receives clear, actionable results

**For Pipelines:**
- Data flows correctly between agents
- Schema compatibility maintained (CatCharacteristics convergence)
- Intermediate results stored appropriately
- Final output meets user's original intent

**For Loops:**
- Retry logic prevents infinite loops (max attempts)
- Feedback improves subsequent generations
- User informed of progress ("Generating... Attempt 2 of 3")
- Success achieved within reasonable attempts

**For Conversational Flows:**
- User feels heard, not interrogated
- Natural dialogue rhythm maintained
- Factors collected efficiently (4-6 turns typical)
- Recommendations feel personalized
- Selection confirmed clearly

**For HITL Workflows:**
- Request clearly formatted for human reviewer
- Timeout handling prevents indefinite blocking
- Approval/rejection handled appropriately
- User understands what happened

## Advanced Patterns and CLI Integration

Parallel, conditional and checkpointed orchestration, plus worked CLI request/response pairs,
are in [orchestration-patterns.md](resources/orchestration-patterns.md).
