import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import { dakflareLight, dakflareDark } from "./lib/shiki-theme";

export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [],
    rehypePlugins: [],
    // The highlighter reads design/tokens.css, like every other surface. See
    // lib/shiki-theme.ts for why the colours are var() references.
    rehypeCodeOptions: {
      themes: {
        light: dakflareLight,
        dark: dakflareDark,
      },
    },
  },
});
