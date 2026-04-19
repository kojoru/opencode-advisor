// Dev entry point for opencode to load when working on this repo.
// Re-exports from src/index.ts — requires `npm install` at the project root
// so that @opencode-ai/plugin is available in root node_modules/.
//
// For end-user "copy a file" installation, copy src/index.ts instead.
export { default } from "../../src/index.ts"
