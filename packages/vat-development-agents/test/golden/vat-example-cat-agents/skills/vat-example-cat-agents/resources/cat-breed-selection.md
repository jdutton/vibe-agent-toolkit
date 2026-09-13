# Cat Breed Selection Skill

Guide for Claude Code to help users select cat breeds through conversational interaction.

## Purpose: For Claude Code, Not the LLM

**Key distinction:**
- **This file** = Guidance for Claude Code (how to orchestrate)
- **Agent resources** = Content for the LLM (what to say/know)

This skill references agent resources via markdown links but doesn't duplicate LLM prompts.

## When to Use This Skill

Trigger this skill when:
- User asks "What cat breed should I get?"
- User wants help finding a cat that fits their lifestyle
- User mentions getting a cat and needs guidance
- User asks about cat breed compatibility

## High-Level Approach

Use the breed-advisor agent which implements a two-phase conversational pattern:

1. **Gathering Phase**: Collect user preferences through natural conversation
2. **Recommendation Phase**: Present matched breeds
3. **Refinement Phase**: Answer questions, compare options
4. **Selection Phase**: Help user make final choice

## Key Factors to Gather

The agent needs these factors (see Factor Definitions for LLM-facing details):

### Critical Factor: Music Preference 🎵

**Why this matters for orchestration:**
- This is the PRIMARY compatibility factor (novelty hook)
- Ask about it EARLY in the conversation
- If user seems confused, explain the music-breed connection
- See Music Preference Insight for the mapping

**Orchestration tip:** Don't just pass this through - use it as the conversation anchor. The quirky music angle makes the interaction memorable.

### Other Factors
- Living Space (apartment → large house)
- Activity Level (couch-companion → high-energy-athlete)
- Grooming Tolerance (minimal → daily)
- Family Composition (single → multi-pet household)
- Allergies (boolean)

## Conversation Orchestration

### Phase 1: Gathering (Natural Dialogue)

**Goal:** Collect ≥4 factors including music preference

**Orchestration strategy:**
- ONE question at a time (don't bombard user)
- Start with music (it's unique and engaging)
- Use natural language (user says "big house" not "large-house")
- Extract factors after each turn (background process)

**Example flow:**
```
Claude: [Welcome Message from agent resources]
User: "I like jazz"
Claude: [Acknowledges, asks about living space]
User: "I have a small apartment"
Claude: [Acknowledges, asks about activity level]
...
```

**When to transition:** ≥4 factors collected AND music preference known

### Phase 2: Recommendations (Structured Presentation)

**Goal:** Present matched breeds, allow exploration

**Orchestration strategy:**
- Present 3-5 breed recommendations (from matchBreeds algorithm)
- Format conversationally (not a data dump)
- Allow user to ask questions about specific breeds
- User can request more details, compare breeds

**Example interaction:**
```
Claude: [Presents 3 breeds with reasoning]
User: "Tell me more about Maine Coons"
Claude: [Detailed info about Maine Coons from breed database]
User: "How do they compare to Persians?"
Claude: [Comparison highlighting differences]
```

### Phase 3: Selection (Confirmation)

**Goal:** Detect final choice, conclude gracefully

**Orchestration strategy:**
- Watch for selection signals ("I'll take", "I want", "sounds good")
- Extract selection in background
- Conclude enthusiastically when selection detected
- Provide exit instruction (`/quit`)

## What Claude Code Does vs What the LLM Does

### Claude Code's Role (This Skill):
- **Orchestrates** the multi-turn conversation
- **Monitors** session state (which factors collected)
- **Triggers** phase transitions (gathering → recommendations → selection)
- **Manages** context (conversation history, extracted profile)
- **Calls** the breed-advisor agent at each turn

### LLM's Role (Agent Resources):
- **Says** the actual prompts (Welcome Message, etc.)
- **Uses** the domain knowledge (Music Insight)
- **Follows** the extraction formats (Factor Extraction)
- **Applies** the conversation strategy (Conversation Strategy)

**Insight:** Skills provide meta-guidance on orchestration. Agents provide actual LLM content.

## Shared vs Separate Content

### What Belongs in Agent Resources (LLM-Facing):
✅ System prompts and LLM instructions
✅ Domain knowledge (music-breed mappings, factor definitions)
✅ Extraction prompts (JSON schemas, format instructions)
✅ Example conversations (few-shot learning)
✅ Natural language mappings ("lazy" → "couch-companion")

### What Belongs in Skills (Claude Code-Facing):
✅ When to use the agent (trigger conditions)
✅ How to orchestrate multi-turn flow (phase transitions)
✅ What to monitor (readiness criteria, selection signals)
✅ Debugging guidance (common issues, pitfalls)
✅ Meta-strategy (why music first, one question at a time)

### Overlap (Appears in Both):
⚠️ Conversation flow structure (both need to understand phases)
⚠️ Factor list (skill explains orchestration, agent explains to LLM)
⚠️ Readiness criteria (skill monitors, agent implements)

**Resolution:** Keep agent resources authoritative for LLM content. Skills REFERENCE agent resources via links, don't duplicate.

## Example: Music Preference Handling

### In Agent Resources (breed-advisor.md):
```markdown
## Music Preference Insight
CRITICAL: Music preference is the MOST IMPORTANT factor...
- Classical: Calm, regal breeds (Persian, Ragdoll)
- Jazz: Intelligent, unpredictable breeds (Siamese, Bengal)
...
```
**Usage:** Injected into LLM system prompt

### In Skills (This File):
```markdown
### Critical Factor: Music Preference
**Why this matters for orchestration:**
- Primary compatibility factor (novelty hook)
- Ask EARLY in conversation
- Use as conversation anchor
- See [Music Insight](../agents/breed-advisor.md#music-preference-insight) for mapping
```
**Usage:** Guides Claude Code on HOW to orchestrate

**Key difference:** Agent says WHAT (the mappings), Skill says WHY and WHEN (orchestration strategy).

## Common Pitfalls

### ❌ Don't: Ask All Questions at Once
```
Bad: "Tell me your music taste, living space, activity level, and family composition"
```

### ✅ Do: One Question at a Time
```
Good: "What's your favorite type of music?"
[User responds]
Good: "Great! Tell me about your living space..."
```

### ❌ Don't: Skip Music Preference
Music is the hook! Don't forget to ask about it.

### ✅ Do: Make Music Central
Start with music, emphasize its importance, use it as the anchor.

## Debugging: When Things Go Wrong

**User provides unmappable music genre:**
- Don't silently map hip-hop → rock
- Ask user: "Hip-hop is great! Which category feels closest: rock, electronic, or pop?"
- Refer to Factor Definitions for clarification guidance

**User is vague about factors:**
- Push for specificity (see Conversation Strategy)
- Don't accept "I'm flexible" for all factors
- Need at least 4 concrete factors

**Conversation stalls:**
- Check if enough factors collected (≥4 + music)
- Transition to recommendations even if not all factors known
- User can refine later

## Related Agent Resources

- Breed Advisor Agent - Complete agent specification
  - Welcome Message - First turn greeting
  - Music Preference Insight - Music-breed mappings
  - Factor Definitions - All 6 factors explained
  - Conversation Strategy - LLM guidance
  - Factor Extraction Prompt - JSON extraction format
  - Transition Message - Readiness announcement
  - Recommendation Presentation - How to present breeds
  - Selection Extraction - Detect final choice
  - Conclusion Prompt - End conversation

## Success Criteria

Conversation is successful when:
- User feels heard (not interrogated)
- Music preference made the conversation memorable
- At least 4 factors collected
- Breed recommendations feel personalized
- User makes a confident selection (or knows they want to research more)

## Additional Resources

Once user selects a breed, you can optionally:
- Help them name their cat using Name Generator
- Provide care tips (future skill)
- Connect with breeders (future skill)
