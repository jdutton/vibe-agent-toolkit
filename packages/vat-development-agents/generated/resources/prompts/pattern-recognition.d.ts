/**
 * Generated TypeScript declarations - DO NOT EDIT
 */

export interface Fragment {
  readonly header: string;
  readonly body: string;
  readonly text: string;
}

export const meta: {};

export const text: string;

export const fragments: {
  readonly pureFunctionToolPattern: Fragment;
  readonly llmAnalyzerPattern: Fragment;
  readonly conversationalAssistantPattern: Fragment;
  readonly agenticWorkflowPattern: Fragment;
  readonly redFlags: Fragment;
};

export type FragmentName = keyof typeof fragments;
