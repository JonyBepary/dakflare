/** Tailwind v4 runs as a PostCSS plugin; Next discovers this file automatically.
 *  Without it the `@import "tailwindcss"` in `app/global.css` is concatenated
 *  verbatim — no utilities, no `@theme`, and `@apply` left in the shipped CSS. */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
