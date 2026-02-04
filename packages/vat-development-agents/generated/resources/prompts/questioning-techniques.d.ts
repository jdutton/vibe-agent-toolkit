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
  readonly askOneAtATime: Fragment;
  readonly pushForSpecificity: Fragment;
  readonly extractConcreteRequirements: Fragment;
  readonly avoidOpenEndedQuestions: Fragment;
};

export type FragmentName = keyof typeof fragments;
