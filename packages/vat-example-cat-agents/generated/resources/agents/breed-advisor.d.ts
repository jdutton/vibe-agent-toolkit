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
  readonly musicPreferenceInsight: Fragment;
  readonly welcomeMessage: Fragment;
  readonly factorDefinitions: Fragment;
  readonly conversationStrategy: Fragment;
  readonly factorExtractionPrompt: Fragment;
  readonly transitionMessage: Fragment;
  readonly recommendationPresentationPrompt: Fragment;
  readonly selectionExtractionPrompt: Fragment;
  readonly conclusionPrompt: Fragment;
};

export type FragmentName = keyof typeof fragments;
