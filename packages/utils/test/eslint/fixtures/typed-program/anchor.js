// The one input this fixture's tsconfig names: TypeScript refuses a config with none. JavaScript,
// so the package's own program (`**/*.ts`) never picks it up. The typed RuleTester's cases are
// virtual files typed in this config's default project.
export {};
