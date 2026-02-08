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
  readonly systemPrompt: Fragment;
  readonly colorDetectionGuidelines: Fragment;
  readonly sizeEstimation: Fragment;
  readonly personalityInference: Fragment;
  readonly outputFormat: Fragment;
  readonly analysisPhilosophy: Fragment;
  readonly examples: Fragment;
  readonly technicalNotes: Fragment;
};

export type FragmentName = keyof typeof fragments;
