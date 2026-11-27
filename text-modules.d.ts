// Prompt templates are bundled as plain text (esbuild `loader: { ".md": "text" }`).
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
