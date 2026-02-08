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
  readonly extractionGuidelines: Fragment;
  readonly naturalLanguageMapping: Fragment;
  readonly outputFormat: Fragment;
  readonly parsingPhilosophy: Fragment;
  readonly examples: Fragment;
  readonly technicalNotes: Fragment;
};

export type FragmentName = keyof typeof fragments;
