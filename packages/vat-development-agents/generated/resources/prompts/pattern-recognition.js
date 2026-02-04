/**
 * Generated from markdown file - DO NOT EDIT
 */

export const meta = {};

export const text = "# Agent Pattern Recognition\n\nGuidance for identifying the right agent archetype based on requirements.\n\n## Pure Function Tool Pattern\n\n**Recognizable by:**\n- Stateless transformation (same input → same output)\n- No conversation needed\n- Clear input/output schema\n- No external dependencies or context\n\n**Examples:**\n- JSON validator\n- Text formatter\n- Data transformer\n- Schema converter\n\n**Best for:** Deterministic operations, utilities, data processing\n\n## LLM Analyzer Pattern\n\n**Recognizable by:**\n- Analysis of unstructured input\n- Produces structured output\n- Single-turn operation\n- No back-and-forth conversation\n\n**Examples:**\n- Sentiment analyzer\n- Code reviewer\n- Document summarizer\n- Requirements extractor\n\n**Best for:** Classification, analysis, extraction, evaluation\n\n## Conversational Assistant Pattern\n\n**Recognizable by:**\n- Multi-turn dialogue\n- Context accumulation across turns\n- Clarifying questions\n- Adaptive responses based on history\n\n**Examples:**\n- Requirements gathering chatbot\n- Technical advisor\n- Interactive troubleshooter\n- Teaching assistant\n\n**Best for:** Exploration, education, consultation, complex requirements\n\n## Agentic Workflow Pattern\n\n**Recognizable by:**\n- Multiple steps/decisions\n- Tool use required\n- External system integration\n- State management across actions\n\n**Examples:**\n- Code generator with file operations\n- Research assistant with web search\n- Data pipeline orchestrator\n- Multi-tool problem solver\n\n**Best for:** Complex automation, integration, multi-step processes\n\n## Red Flags\n\n**When to NOT use agents:**\n- Simple rule-based logic (use if/else)\n- Known algorithm exists (use traditional code)\n- Real-time requirements (<100ms)\n- Deterministic correctness required (use formal verification)\n";

export const fragments = {
  pureFunctionToolPattern: {
    header: "## Pure Function Tool Pattern",
    body: "**Recognizable by:**\n- Stateless transformation (same input → same output)\n- No conversation needed\n- Clear input/output schema\n- No external dependencies or context\n\n**Examples:**\n- JSON validator\n- Text formatter\n- Data transformer\n- Schema converter\n\n**Best for:** Deterministic operations, utilities, data processing",
    text: "## Pure Function Tool Pattern\n\n**Recognizable by:**\n- Stateless transformation (same input → same output)\n- No conversation needed\n- Clear input/output schema\n- No external dependencies or context\n\n**Examples:**\n- JSON validator\n- Text formatter\n- Data transformer\n- Schema converter\n\n**Best for:** Deterministic operations, utilities, data processing"
  },
  llmAnalyzerPattern: {
    header: "## LLM Analyzer Pattern",
    body: "**Recognizable by:**\n- Analysis of unstructured input\n- Produces structured output\n- Single-turn operation\n- No back-and-forth conversation\n\n**Examples:**\n- Sentiment analyzer\n- Code reviewer\n- Document summarizer\n- Requirements extractor\n\n**Best for:** Classification, analysis, extraction, evaluation",
    text: "## LLM Analyzer Pattern\n\n**Recognizable by:**\n- Analysis of unstructured input\n- Produces structured output\n- Single-turn operation\n- No back-and-forth conversation\n\n**Examples:**\n- Sentiment analyzer\n- Code reviewer\n- Document summarizer\n- Requirements extractor\n\n**Best for:** Classification, analysis, extraction, evaluation"
  },
  conversationalAssistantPattern: {
    header: "## Conversational Assistant Pattern",
    body: "**Recognizable by:**\n- Multi-turn dialogue\n- Context accumulation across turns\n- Clarifying questions\n- Adaptive responses based on history\n\n**Examples:**\n- Requirements gathering chatbot\n- Technical advisor\n- Interactive troubleshooter\n- Teaching assistant\n\n**Best for:** Exploration, education, consultation, complex requirements",
    text: "## Conversational Assistant Pattern\n\n**Recognizable by:**\n- Multi-turn dialogue\n- Context accumulation across turns\n- Clarifying questions\n- Adaptive responses based on history\n\n**Examples:**\n- Requirements gathering chatbot\n- Technical advisor\n- Interactive troubleshooter\n- Teaching assistant\n\n**Best for:** Exploration, education, consultation, complex requirements"
  },
  agenticWorkflowPattern: {
    header: "## Agentic Workflow Pattern",
    body: "**Recognizable by:**\n- Multiple steps/decisions\n- Tool use required\n- External system integration\n- State management across actions\n\n**Examples:**\n- Code generator with file operations\n- Research assistant with web search\n- Data pipeline orchestrator\n- Multi-tool problem solver\n\n**Best for:** Complex automation, integration, multi-step processes",
    text: "## Agentic Workflow Pattern\n\n**Recognizable by:**\n- Multiple steps/decisions\n- Tool use required\n- External system integration\n- State management across actions\n\n**Examples:**\n- Code generator with file operations\n- Research assistant with web search\n- Data pipeline orchestrator\n- Multi-tool problem solver\n\n**Best for:** Complex automation, integration, multi-step processes"
  },
  redFlags: {
    header: "## Red Flags",
    body: "**When to NOT use agents:**\n- Simple rule-based logic (use if/else)\n- Known algorithm exists (use traditional code)\n- Real-time requirements (<100ms)\n- Deterministic correctness required (use formal verification)",
    text: "## Red Flags\n\n**When to NOT use agents:**\n- Simple rule-based logic (use if/else)\n- Known algorithm exists (use traditional code)\n- Real-time requirements (<100ms)\n- Deterministic correctness required (use formal verification)"
  }
};
