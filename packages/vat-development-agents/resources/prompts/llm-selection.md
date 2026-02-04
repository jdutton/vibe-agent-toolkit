# LLM Selection Guidance

Guidelines for selecting the right LLM based on agent requirements.

## Claude Models

**Claude 3.5 Sonnet:**
- **Best for:** Complex reasoning, coding, analysis
- **Strengths:** Long context (200K), tool use, function calling
- **Cost:** Mid-range ($3/$15 per 1M tokens)
- **Latency:** ~2-5 seconds

**Claude 3 Haiku:**
- **Best for:** Fast, simple tasks, high-volume
- **Strengths:** Speed, cost-effective
- **Cost:** Low ($0.25/$1.25 per 1M tokens)
- **Latency:** ~500ms-1s

## OpenAI Models

**GPT-4 Turbo:**
- **Best for:** Complex reasoning, multimodal
- **Strengths:** Vision, JSON mode, function calling
- **Cost:** Mid-range ($10/$30 per 1M tokens)
- **Latency:** ~2-4 seconds

**GPT-3.5 Turbo:**
- **Best for:** Simple tasks, cost-sensitive
- **Strengths:** Fast, cheap, widely deployed
- **Cost:** Very low ($0.50/$1.50 per 1M tokens)
- **Latency:** ~500ms-1s

## Selection Criteria

**Choose by latency:**
- Real-time (<1s): Haiku, GPT-3.5
- Interactive (<5s): Sonnet, GPT-4
- Batch (>5s acceptable): Any model

**Choose by complexity:**
- Simple classification: Haiku, GPT-3.5
- Reasoning/analysis: Sonnet, GPT-4
- Complex multi-step: Sonnet, GPT-4 Turbo

**Choose by cost:**
- High volume: Haiku, GPT-3.5
- Medium volume: Sonnet
- Low volume/critical: GPT-4, Sonnet

**Choose by features:**
- Vision needed: GPT-4 Turbo (multimodal)
- Long context: Claude (200K vs 128K)
- Structured output: GPT-4 (native JSON mode)
- Tool use: Claude (best-in-class)

## Common Mistakes

**Over-engineering:**
- Using GPT-4 for simple classification (use Haiku/GPT-3.5)
- Using latest model when older works fine

**Under-engineering:**
- Using GPT-3.5 for complex reasoning (upgrade to Sonnet/GPT-4)
- Skipping evaluation (always benchmark)

**Cost blindness:**
- Not considering volume × price
- Ignoring prompt optimization opportunities
