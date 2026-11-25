/** Types for `eslint-config-support.js`; see that file for each helper's contract. */
export declare const IGNORE_FILES: readonly string[];
export declare function gitignorePatterns(text: string, ignoreFile: string): string[];
export declare function declaredTypesFiles(manifest: Record<string, unknown>, where: string): string[];
export declare function programTaskRefusal(task: 'lint' | 'typecheck', env: Record<string, string | undefined>, listMissingTypes: () => string[]): string | undefined;
export declare function workspacePackages(): Array<{ dir: string; name: string }>;
export declare function missingDeclaredTypes(): string[];
