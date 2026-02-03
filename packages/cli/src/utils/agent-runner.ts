/**
 * Agent Runner Utility
 *
 * Minimal runner for executing agents with LLM providers.
 * Loads manifests, prompts, and handles API calls.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { loadAgentManifest, type LoadedAgentManifest } from '@vibe-agent-toolkit/agent-config';

export interface RunAgentOptions {
  userInput: string;
  debug?: boolean;
}

export interface RunAgentResult {
  response: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Loads a prompt file from the agent directory
 */
async function loadPromptFile(manifestPath: string, promptRef: string): Promise<string> {
  const agentDir = path.dirname(manifestPath);
  const promptPath = path.resolve(agentDir, promptRef.replace(/^\.\//u, ''));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is derived from validated manifest
  return await fs.readFile(promptPath, 'utf-8');
}

/**
 * Simple template variable substitution
 * For MVP: Only handles {{userInput}} and strips Jinja2 conditionals
 */
function substituteTemplate(template: string, variables: Record<string, string>): string {
  let result = template;

  // Replace {{variable}} placeholders
  for (const [key, value] of Object.entries(variables)) {
    // Use String.raw to avoid escaping and replaceAll for complete replacement
    const placeholder = String.raw`\{\{\s*${key}\s*\}\}`;
    // eslint-disable-next-line security/detect-non-literal-regexp -- Variable name from controlled source
    const regex = new RegExp(placeholder, 'gu');
    result = result.replaceAll(regex, value);
  }

  // Strip Jinja2 conditional blocks {% if ... %}...{% endif %}
  // This is a simple regex approach for MVP - won't handle nested conditionals
  // Using [^] instead of [\s\S] to match any character including newlines
  // eslint-disable-next-line sonarjs/slow-regex -- Simple template stripping, not user-controlled input
  result = result.replaceAll(/\{%\s*if\s+[^%]+%\}[^]*?\{%\s*endif\s*%\}/gu, '');

  return result.trim();
}

/**
 * Runs an agent with the specified input
 */
export async function runAgent(
  pathOrName: string,
  options: RunAgentOptions
): Promise<RunAgentResult> {
  const { userInput, debug } = options;

  // Load agent manifest
  const manifest: LoadedAgentManifest = await loadAgentManifest(pathOrName);

  if (debug) {
    console.error(`[DEBUG] Loaded agent: ${String(manifest.metadata.name)} v${String(manifest.metadata.version ?? 'unknown')}`);
    console.error(`[DEBUG] Provider: ${manifest.spec.llm.provider}, Model: ${manifest.spec.llm.model}`);
  }

  // Validate provider
  if (manifest.spec.llm.provider !== 'anthropic') {
    throw new Error(
      `Unsupported LLM provider: ${manifest.spec.llm.provider}. Currently only 'anthropic' is supported.`
    );
  }

  // Validate prompts configuration
  if (!manifest.spec.prompts) {
    throw new Error(`Agent ${manifest.metadata.name} is missing prompts configuration`);
  }
  if (!manifest.spec.prompts.system?.$ref) {
    throw new Error(`Agent ${manifest.metadata.name} is missing system prompt reference`);
  }
  if (!manifest.spec.prompts.user?.$ref) {
    throw new Error(`Agent ${manifest.metadata.name} is missing user prompt reference`);
  }

  // Load prompts
  const systemPromptRef = manifest.spec.prompts.system.$ref;
  const userPromptRef = manifest.spec.prompts.user.$ref;

  const systemPrompt = await loadPromptFile(manifest.__manifestPath, systemPromptRef);
  const userPromptTemplate = await loadPromptFile(manifest.__manifestPath, userPromptRef);

  if (debug) {
    console.error(`[DEBUG] System prompt length: ${systemPrompt.length} chars`);
    console.error(`[DEBUG] User prompt template length: ${userPromptTemplate.length} chars`);
  }

  // Substitute user prompt variables
  const userPrompt = substituteTemplate(userPromptTemplate, { userInput });

  if (debug) {
    console.error(`[DEBUG] Substituted user prompt length: ${userPrompt.length} chars`);
    console.error('[DEBUG] Calling Anthropic API...');
  }

  // Call Anthropic API
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is not set. Please set it to use Anthropic-based agents.'
    );
  }

  const client = new Anthropic({ apiKey });

  // Use manifest config or sensible defaults
  const maxTokens = manifest.spec.llm.maxTokens ?? 4096;
  const temperature = manifest.spec.llm.temperature ?? 1;

  const response = await client.messages.create({
    model: manifest.spec.llm.model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt,
      },
    ],
  });

  if (debug) {
    console.error(`[DEBUG] API call complete. Status: ${String(response.stop_reason ?? 'unknown')}`);
    console.error(`[DEBUG] Input tokens: ${response.usage.input_tokens}`);
    console.error(`[DEBUG] Output tokens: ${response.usage.output_tokens}`);
  }

  // Extract text response
  const textContent = response.content.find((block) => block.type === 'text');
  if (textContent?.type !== 'text') {
    throw new Error('No text content in API response');
  }

  return {
    response: textContent.text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
