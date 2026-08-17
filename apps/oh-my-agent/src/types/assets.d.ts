/** Prompt assets are imported as text (Bun `with { type: "text" }`);
 *  tsc needs this ambient declaration to type them as strings. */
declare module "*.md" {
  const content: string;
  export default content;
}
