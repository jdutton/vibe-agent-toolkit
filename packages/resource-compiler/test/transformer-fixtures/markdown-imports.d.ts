/**
 * The module shape the transformer gives a `.md` import, as the `.ts` fixtures beside this file
 * use it (`sample.md`, `empty.md`). The fixtures are transformer inputs, never compiled into the
 * package; this declaration is what lets the typecheck of the test program read them as a consumer
 * with generated `.md.d.ts` files would.
 */
declare module '*.md' {
  interface Fragment {
    readonly header: string;
    readonly body: string;
    readonly text: string;
  }
  export const meta: { readonly title: string };
  export const text: string;
  export const fragments: { readonly introduction: Fragment };
  const resource: { readonly meta: typeof meta; readonly text: string; readonly fragments: typeof fragments };
  export default resource;
}
