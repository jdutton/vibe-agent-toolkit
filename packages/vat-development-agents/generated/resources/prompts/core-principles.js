/**
 * Generated from markdown file - DO NOT EDIT
 */

export const meta = {};

export const text = "# Agent Design Core Principles\n\nThese are the foundational principles for designing high-quality AI agents.\n\n## Purpose Driven\n\nA well-designed agent solves a specific problem with clear success criteria.\n\n**NOT**: \"A helpful assistant\" (too vague)\n\n**YES**: \"Reviews PR diffs for security vulnerabilities, suggests fixes\"\n\n## Simple First\n\nStart with single-agent, deterministic paths.\n\n- Avoid multi-agent complexity unless clearly needed\n- Prefer simple tools over complex frameworks\n- \"Most successful implementations use simple, composable patterns\" (Anthropic)\n\n## Context Efficient\n\nUse \"smallest set of high-signal tokens\".\n\n- Prompts should provide information the LLM doesn\'t already know\n- Avoid redundancy with training data (don\'t explain common concepts)\n- Structure context hierarchically (identity → task → tools → memory)\n\n## Testable\n\nClear inputs/outputs enable validation.\n\n- Structured I/O schemas (JSON Schema format)\n- Example test cases included\n- Success measurable (accuracy, latency, cost)\n\n## Tool Appropriate\n\nRight tools for the job.\n\n- File operations? File system tools\n- Current info needed? Web search/APIs\n- Minimize tool count (each tool adds complexity)\n";

export const fragments = {
  purposeDriven: {
    header: "## Purpose Driven",
    body: "A well-designed agent solves a specific problem with clear success criteria.\n\n**NOT**: \"A helpful assistant\" (too vague)\n\n**YES**: \"Reviews PR diffs for security vulnerabilities, suggests fixes\"",
    text: "## Purpose Driven\n\nA well-designed agent solves a specific problem with clear success criteria.\n\n**NOT**: \"A helpful assistant\" (too vague)\n\n**YES**: \"Reviews PR diffs for security vulnerabilities, suggests fixes\""
  },
  simpleFirst: {
    header: "## Simple First",
    body: "Start with single-agent, deterministic paths.\n\n- Avoid multi-agent complexity unless clearly needed\n- Prefer simple tools over complex frameworks\n- \"Most successful implementations use simple, composable patterns\" (Anthropic)",
    text: "## Simple First\n\nStart with single-agent, deterministic paths.\n\n- Avoid multi-agent complexity unless clearly needed\n- Prefer simple tools over complex frameworks\n- \"Most successful implementations use simple, composable patterns\" (Anthropic)"
  },
  contextEfficient: {
    header: "## Context Efficient",
    body: "Use \"smallest set of high-signal tokens\".\n\n- Prompts should provide information the LLM doesn\'t already know\n- Avoid redundancy with training data (don\'t explain common concepts)\n- Structure context hierarchically (identity → task → tools → memory)",
    text: "## Context Efficient\n\nUse \"smallest set of high-signal tokens\".\n\n- Prompts should provide information the LLM doesn\'t already know\n- Avoid redundancy with training data (don\'t explain common concepts)\n- Structure context hierarchically (identity → task → tools → memory)"
  },
  testable: {
    header: "## Testable",
    body: "Clear inputs/outputs enable validation.\n\n- Structured I/O schemas (JSON Schema format)\n- Example test cases included\n- Success measurable (accuracy, latency, cost)",
    text: "## Testable\n\nClear inputs/outputs enable validation.\n\n- Structured I/O schemas (JSON Schema format)\n- Example test cases included\n- Success measurable (accuracy, latency, cost)"
  },
  toolAppropriate: {
    header: "## Tool Appropriate",
    body: "Right tools for the job.\n\n- File operations? File system tools\n- Current info needed? Web search/APIs\n- Minimize tool count (each tool adds complexity)",
    text: "## Tool Appropriate\n\nRight tools for the job.\n\n- File operations? File system tools\n- Current info needed? Web search/APIs\n- Minimize tool count (each tool adds complexity)"
  }
};
