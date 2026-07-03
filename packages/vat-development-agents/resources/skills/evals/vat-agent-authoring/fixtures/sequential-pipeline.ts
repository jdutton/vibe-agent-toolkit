import { analyzer } from './analyzer.js';
import { summarizer } from './summarizer.js';

interface PipelineInput {
  text: string;
}

// Two-stage pipeline: analyze the document, then summarize the findings.
// analyzer and summarizer are both VAT agents (they return result envelopes).
export async function analyzeAndSummarize(input: PipelineInput) {
  const analysisOutput = await analyzer.execute(input);

  // Hand the analysis findings straight to the summarizer.
  const summaryOutput = await summarizer.execute({
    findings: analysisOutput.result.data,
  });

  return summaryOutput.result.data;
}
