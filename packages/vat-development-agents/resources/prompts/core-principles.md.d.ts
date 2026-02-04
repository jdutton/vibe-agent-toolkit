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
  readonly purposeDriven: Fragment;
  readonly simpleFirst: Fragment;
  readonly contextEfficient: Fragment;
  readonly testable: Fragment;
  readonly toolAppropriate: Fragment;
};

export type FragmentName = keyof typeof fragments;
