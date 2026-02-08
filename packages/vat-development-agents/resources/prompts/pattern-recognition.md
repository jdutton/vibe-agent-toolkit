# Agent Pattern Recognition

Guidance for identifying the right agent archetype based on requirements.

## Pure Function Tool Pattern

**Recognizable by:**
- Stateless transformation (same input → same output)
- No conversation needed
- Clear input/output schema
- No external dependencies or context

**Examples:**
- JSON validator
- Text formatter
- Data transformer
- Schema converter

**Best for:** Deterministic operations, utilities, data processing

## LLM Analyzer Pattern

**Recognizable by:**
- Analysis of unstructured input
- Produces structured output
- Single-turn operation
- No back-and-forth conversation

**Examples:**
- Sentiment analyzer
- Code reviewer
- Document summarizer
- Requirements extractor

**Best for:** Classification, analysis, extraction, evaluation

## Conversational Assistant Pattern

**Recognizable by:**
- Multi-turn dialogue
- Context accumulation across turns
- Clarifying questions
- Adaptive responses based on history

**Examples:**
- Requirements gathering chatbot
- Technical advisor
- Interactive troubleshooter
- Teaching assistant

**Best for:** Exploration, education, consultation, complex requirements

## Agentic Workflow Pattern

**Recognizable by:**
- Multiple steps/decisions
- Tool use required
- External system integration
- State management across actions

**Examples:**
- Code generator with file operations
- Research assistant with web search
- Data pipeline orchestrator
- Multi-tool problem solver

**Best for:** Complex automation, integration, multi-step processes

## Red Flags

**When to NOT use agents:**
- Simple rule-based logic (use if/else)
- Known algorithm exists (use traditional code)
- Real-time requirements (<100ms)
- Deterministic correctness required (use formal verification)
