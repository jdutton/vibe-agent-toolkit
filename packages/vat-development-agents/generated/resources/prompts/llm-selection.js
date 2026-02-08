/**
 * Generated from markdown file - DO NOT EDIT
 */

export const meta = {};

export const text = "# LLM Selection Guidance\n\nGuidelines for selecting the right LLM based on agent requirements.\n\n## Claude Models\n\n**Claude 3.5 Sonnet:**\n- **Best for:** Complex reasoning, coding, analysis\n- **Strengths:** Long context (200K), tool use, function calling\n- **Cost:** Mid-range ($3/$15 per 1M tokens)\n- **Latency:** ~2-5 seconds\n\n**Claude 3 Haiku:**\n- **Best for:** Fast, simple tasks, high-volume\n- **Strengths:** Speed, cost-effective\n- **Cost:** Low ($0.25/$1.25 per 1M tokens)\n- **Latency:** ~500ms-1s\n\n## OpenAI Models\n\n**GPT-4 Turbo:**\n- **Best for:** Complex reasoning, multimodal\n- **Strengths:** Vision, JSON mode, function calling\n- **Cost:** Mid-range ($10/$30 per 1M tokens)\n- **Latency:** ~2-4 seconds\n\n**GPT-3.5 Turbo:**\n- **Best for:** Simple tasks, cost-sensitive\n- **Strengths:** Fast, cheap, widely deployed\n- **Cost:** Very low ($0.50/$1.50 per 1M tokens)\n- **Latency:** ~500ms-1s\n\n## Selection Criteria\n\n**Choose by latency:**\n- Real-time (<1s): Haiku, GPT-3.5\n- Interactive (<5s): Sonnet, GPT-4\n- Batch (>5s acceptable): Any model\n\n**Choose by complexity:**\n- Simple classification: Haiku, GPT-3.5\n- Reasoning/analysis: Sonnet, GPT-4\n- Complex multi-step: Sonnet, GPT-4 Turbo\n\n**Choose by cost:**\n- High volume: Haiku, GPT-3.5\n- Medium volume: Sonnet\n- Low volume/critical: GPT-4, Sonnet\n\n**Choose by features:**\n- Vision needed: GPT-4 Turbo (multimodal)\n- Long context: Claude (200K vs 128K)\n- Structured output: GPT-4 (native JSON mode)\n- Tool use: Claude (best-in-class)\n\n## Common Mistakes\n\n**Over-engineering:**\n- Using GPT-4 for simple classification (use Haiku/GPT-3.5)\n- Using latest model when older works fine\n\n**Under-engineering:**\n- Using GPT-3.5 for complex reasoning (upgrade to Sonnet/GPT-4)\n- Skipping evaluation (always benchmark)\n\n**Cost blindness:**\n- Not considering volume × price\n- Ignoring prompt optimization opportunities\n";

export const fragments = {
  claudeModels: {
    header: "## Claude Models",
    body: "**Claude 3.5 Sonnet:**\n- **Best for:** Complex reasoning, coding, analysis\n- **Strengths:** Long context (200K), tool use, function calling\n- **Cost:** Mid-range ($3/$15 per 1M tokens)\n- **Latency:** ~2-5 seconds\n\n**Claude 3 Haiku:**\n- **Best for:** Fast, simple tasks, high-volume\n- **Strengths:** Speed, cost-effective\n- **Cost:** Low ($0.25/$1.25 per 1M tokens)\n- **Latency:** ~500ms-1s",
    text: "## Claude Models\n\n**Claude 3.5 Sonnet:**\n- **Best for:** Complex reasoning, coding, analysis\n- **Strengths:** Long context (200K), tool use, function calling\n- **Cost:** Mid-range ($3/$15 per 1M tokens)\n- **Latency:** ~2-5 seconds\n\n**Claude 3 Haiku:**\n- **Best for:** Fast, simple tasks, high-volume\n- **Strengths:** Speed, cost-effective\n- **Cost:** Low ($0.25/$1.25 per 1M tokens)\n- **Latency:** ~500ms-1s"
  },
  openaiModels: {
    header: "## OpenAI Models",
    body: "**GPT-4 Turbo:**\n- **Best for:** Complex reasoning, multimodal\n- **Strengths:** Vision, JSON mode, function calling\n- **Cost:** Mid-range ($10/$30 per 1M tokens)\n- **Latency:** ~2-4 seconds\n\n**GPT-3.5 Turbo:**\n- **Best for:** Simple tasks, cost-sensitive\n- **Strengths:** Fast, cheap, widely deployed\n- **Cost:** Very low ($0.50/$1.50 per 1M tokens)\n- **Latency:** ~500ms-1s",
    text: "## OpenAI Models\n\n**GPT-4 Turbo:**\n- **Best for:** Complex reasoning, multimodal\n- **Strengths:** Vision, JSON mode, function calling\n- **Cost:** Mid-range ($10/$30 per 1M tokens)\n- **Latency:** ~2-4 seconds\n\n**GPT-3.5 Turbo:**\n- **Best for:** Simple tasks, cost-sensitive\n- **Strengths:** Fast, cheap, widely deployed\n- **Cost:** Very low ($0.50/$1.50 per 1M tokens)\n- **Latency:** ~500ms-1s"
  },
  selectionCriteria: {
    header: "## Selection Criteria",
    body: "**Choose by latency:**\n- Real-time (<1s): Haiku, GPT-3.5\n- Interactive (<5s): Sonnet, GPT-4\n- Batch (>5s acceptable): Any model\n\n**Choose by complexity:**\n- Simple classification: Haiku, GPT-3.5\n- Reasoning/analysis: Sonnet, GPT-4\n- Complex multi-step: Sonnet, GPT-4 Turbo\n\n**Choose by cost:**\n- High volume: Haiku, GPT-3.5\n- Medium volume: Sonnet\n- Low volume/critical: GPT-4, Sonnet\n\n**Choose by features:**\n- Vision needed: GPT-4 Turbo (multimodal)\n- Long context: Claude (200K vs 128K)\n- Structured output: GPT-4 (native JSON mode)\n- Tool use: Claude (best-in-class)",
    text: "## Selection Criteria\n\n**Choose by latency:**\n- Real-time (<1s): Haiku, GPT-3.5\n- Interactive (<5s): Sonnet, GPT-4\n- Batch (>5s acceptable): Any model\n\n**Choose by complexity:**\n- Simple classification: Haiku, GPT-3.5\n- Reasoning/analysis: Sonnet, GPT-4\n- Complex multi-step: Sonnet, GPT-4 Turbo\n\n**Choose by cost:**\n- High volume: Haiku, GPT-3.5\n- Medium volume: Sonnet\n- Low volume/critical: GPT-4, Sonnet\n\n**Choose by features:**\n- Vision needed: GPT-4 Turbo (multimodal)\n- Long context: Claude (200K vs 128K)\n- Structured output: GPT-4 (native JSON mode)\n- Tool use: Claude (best-in-class)"
  },
  commonMistakes: {
    header: "## Common Mistakes",
    body: "**Over-engineering:**\n- Using GPT-4 for simple classification (use Haiku/GPT-3.5)\n- Using latest model when older works fine\n\n**Under-engineering:**\n- Using GPT-3.5 for complex reasoning (upgrade to Sonnet/GPT-4)\n- Skipping evaluation (always benchmark)\n\n**Cost blindness:**\n- Not considering volume × price\n- Ignoring prompt optimization opportunities",
    text: "## Common Mistakes\n\n**Over-engineering:**\n- Using GPT-4 for simple classification (use Haiku/GPT-3.5)\n- Using latest model when older works fine\n\n**Under-engineering:**\n- Using GPT-3.5 for complex reasoning (upgrade to Sonnet/GPT-4)\n- Skipping evaluation (always benchmark)\n\n**Cost blindness:**\n- Not considering volume × price\n- Ignoring prompt optimization opportunities"
  }
};
