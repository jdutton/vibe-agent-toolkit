/** Types for `eslint-config-support.js`; see that file for each helper's contract. */
export declare const IGNORE_FILES: readonly string[];
export declare function gitignorePatterns(text: string, ignoreFile: string): string[];
export declare function declaredTypesFiles(manifest: Record<string, unknown>, where: string): string[];
export declare function lintTaskRefusal(env: Record<string, string | undefined>, listMissingTypes: () => string[]): string | undefined;
