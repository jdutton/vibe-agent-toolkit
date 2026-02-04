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
  readonly colorNameMappings: Fragment;
  readonly personalityBasedNames: Fragment;
  readonly popCultureReferences: Fragment;
  readonly outputFormat: Fragment;
  readonly namingPhilosophy: Fragment;
  readonly examples: Fragment;
};

export type FragmentName = keyof typeof fragments;
