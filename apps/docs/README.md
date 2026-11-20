# The documentation site

A Fumadocs application (Next.js App Router + MDX) that renders the material in `../../docs/` for
a reader who does not want to browse a repository — and for an agent that would rather fetch
markdown than scrape HTML.

`docs/` is the source of truth. This app is a presentation of it: when a fact changes, correct it
there first and mirror it here.

```bash
npm ci
npm run dev      # http://localhost:3000
npm run build    # prerenders every page; this is the gate CI runs
npm run typecheck
npm start        # serve the build
```

## What it serves

| | |
|---|---|
| `/docs/...` | 25 pages in seven sections — start, service binding, guides, reference, architecture, agents — with the sidebar and per-page actions from `content/docs/**/meta.json` |
| `/docs/{slug}.md` | the same page as clean markdown, generated from the MDX at build, and `/docs/...` with `Accept: text/markdown` is rewritten to it by `middleware.ts` |
| `/llms.txt`, `/llms-full.txt` | the index and the whole bundle, for an agent that wants one fetch |
| `/openapi.json` | the edge API as OpenAPI 3.1, which also drives the playground |
| `/mcp` | an MCP endpoint (`/api/mcp`), so an agent can read the docs over the protocol it already speaks |
| `/SKILL.md`, `/AGENTS.md` | in `public/`, served as static files |

## One source, two renderings

`content/docs/**/*.mdx` is the only file you edit. `scripts/sync-markdown.mjs` generates the
markdown copies that `/docs/{slug}.md` serves into `public/md/` — on `predev` and `prebuild`, so
they cannot go stale, and `npm run check:md` compares instead of writing if you want to see the
difference. `public/md/` is git-ignored.

That generation is not a convenience. Those copies used to be hand-kept, and the cost was real:
four pages repeated a wrong command count, and an import was corrected in the MDX while its
markdown twin kept the old one. Two files, one truth.

The transform is the one the copies were made with: frontmatter becomes an H1 and a blockquote,
code fences are never touched, and two markers decide what a machine reader sees —
`{/* llms-ignore:start */}` drops a block, `{/* llms-only:start */}` names the page's own heading
for that audience.

## Stack, and why the versions are what they are

This app arrived written against package versions that **have never existed on npm** —
`fumadocs-openapi@^8.7.0` among them — so it had never been installed or built. It now runs on
the published majors:

| Package | Version |
|---|---|
| `fumadocs-core` | `16.19.4` |
| `fumadocs-mdx` | `15.6.3` |
| `fumadocs-ui` | `16.19.4` |
| `fumadocs-openapi` | `12.6.5` |
| `next` | `16.4.6` |
| `react` | `19.x` |

The v15 → v16 port touched four things, all of them import or factory changes rather than content:
the provider moved to `fumadocs-ui/provider/next`; `fumadocs-mdx` emits `.source/server` with no
index barrel; `createOpenAPI` takes an array instead of a function; and `fumadocs-openapi` v12
removed the named `APIPage` export in favour of `createOpenAPIPage()`, which
`components/OpenAPIPage.tsx` wraps. MDX 3 also rejects HTML comments, so the `llms-ignore` markers
are MDX expression comments.

Two known consequences, stated rather than hidden:

- **`template: splash` no longer does anything.** v16's page schema has no `template` field, so the
  index renders through the standard docs layout instead of the old splash. It is a layout
  preference, not content, and it can be restored with a custom page when someone wants it.
- **`middleware.ts` is deprecated in favour of `proxy.ts`** in Next 16. It still works; the file
  keeps its name because the markdown negotiation it performs is part of the agent surface and a
  rename should be a deliberate change, not a build warning.

## Why the build runs webpack

`next build` and `next dev` pass `--webpack` on purpose. The theme imports `design/tokens.css`
from outside this app, which Turbopack only allows when `turbopack.root` is the repository root;
with that set, Next writes `.next/standalone/apps/docs/…` while OpenNext — which finds the
monorepo root from `apps/docs/package-lock.json` — looks for `.next/standalone/.next/…`. Next
forces `outputFileTracingRoot` to equal `turbopack.root`, so the two cannot be reconciled. Webpack
builds where OpenNext expects, and that is the only reason `build:worker` passes.

If someone removes the flag, the failure is `build:worker` looking in a directory the build never
wrote — not a styling problem, which is worth knowing before debugging the wrong layer.

## Deploying it

Not configured here. There is no `wrangler` config and no OpenNext target in this directory, so
the site builds and serves but has no deployment story of its own; putting it on Cloudflare Pages
or Workers means choosing one and adding its config. The rest of the repository deploys with `cf`
(`docs/OPS_DEPLOY.md`) and this app was deliberately not given a half-working `deploy` script.
