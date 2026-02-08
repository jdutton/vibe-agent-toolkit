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
  readonly claudeModels: Fragment;
  readonly openaiModels: Fragment;
  readonly selectionCriteria: Fragment;
  readonly commonMistakes: Fragment;
};

export type FragmentName = keyof typeof fragments;
