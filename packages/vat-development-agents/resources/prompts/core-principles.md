# Agent Design Core Principles

These are the foundational principles for designing high-quality AI agents.

## Purpose Driven

A well-designed agent solves a specific problem with clear success criteria.

**NOT**: "A helpful assistant" (too vague)

**YES**: "Reviews PR diffs for security vulnerabilities, suggests fixes"

## Simple First

Start with single-agent, deterministic paths.

- Avoid multi-agent complexity unless clearly needed
- Prefer simple tools over complex frameworks
- "Most successful implementations use simple, composable patterns" (Anthropic)

## Context Efficient

Use "smallest set of high-signal tokens".

- Prompts should provide information the LLM doesn't already know
- Avoid redundancy with training data (don't explain common concepts)
- Structure context hierarchically (identity → task → tools → memory)

## Testable

Clear inputs/outputs enable validation.

- Structured I/O schemas (JSON Schema format)
- Example test cases included
- Success measurable (accuracy, latency, cost)

## Tool Appropriate

Right tools for the job.

- File operations? File system tools
- Current info needed? Web search/APIs
- Minimize tool count (each tool adds complexity)
