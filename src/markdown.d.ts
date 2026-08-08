/**
 * Markdown imported as text. Bun resolves `import doc from "./x.md" with {
 * type: "text" }` to the file's contents and inlines them into the module
 * graph — which is how the canonical workflow docs travel inside a
 * `bun build --compile` binary (src/install/canonical-workflows.ts, its one
 * consumer). Bun ships ambient types for *.txt, *.yaml, *.html and friends but
 * not for *.md, so this declaration is what lets `tsc --noEmit` see those
 * imports as the strings they are.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
