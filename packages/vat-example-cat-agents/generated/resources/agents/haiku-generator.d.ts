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
  readonly traditionalHaikuElements: Fragment;
  readonly haikuGenerationGuidelines: Fragment;
  readonly creativeLicense40percentOfTheTime: Fragment;
  readonly outputFormat: Fragment;
  readonly haikuPhilosophy: Fragment;
  readonly examples: Fragment;
  readonly generationProcess: Fragment;
  readonly technicalNotes: Fragment;
};

export type FragmentName = keyof typeof fragments;
