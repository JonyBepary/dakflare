# DakFlare admin console

The operator console for a DakFlare deployment. SvelteKit with `adapter-static`;
every route is prerendered to its own HTML file under `worker/public/admin`, which
the Worker serves at `/admin`. All asset URLs and routes carry the `/admin` base.

## Routes

| Route | Screen |
|---|---|
| `/login` | sign in |
| `/invite` | redeem an invite |
| `/enrol` | create the account and its first passkey |
| `/magic` | consume a magic-link token |
| `/` | overview: health, fleet, recent activity |
| `/devices` | fleet table and device detail |
| `/messages` | message log with delivery state |
| `/rules` | sentence-shaped rules |
| `/workflows` | workflow list |
| `/workflows/edit` | canvas editor; the workflow id is a query parameter |
| `/approvals` | pending agent authority requests |
| `/audit` | privileged-action log |
| `/security` | sign-in factors and invites |

These are relative to `/admin`, so the overview is `/admin/` and the device
screen is `/admin/devices`.

## Design system

`design/tokens.css` is the only source of values. It is layered primitive →
semantic → component, and `src/app.css` imports it. Styling is hand-written CSS
with no utility framework. Tokens cover colour, type, spacing, radii and the
component geometry; screens should use semantic tokens rather than primitives.

## Local work

```bash
npm install
npm run dev       # Vite, proxying /v1 and /api/auth to wrangler dev on :8787
npm run check     # svelte-kit sync + svelte-check
npm run build     # writes ../worker/public/admin
```

From `worker/`, `npm run dev:dashboard` starts the console and
`npm run build:dashboard` installs and builds it before a deploy.

## Layout rule

The console measures its content column, not the window. The rail takes 249 px,
so a 914 px window leaves the page about 616 px. Tables therefore switch to
stacked rows on a container query over their card, never on `@media`.

The fleet table needs a 966 px card, about a 1282 px window, for its six columns;
below that the fleet is a stacked card. The login page and every console page
were measured at 390, 768, 914, 1024 and 1440 with no horizontal overflow.

## Sign-in

The doors are passkey, TOTP, password and magic link. Which ones appear depends
on the deployment. The full factor model, sessions and role rules live in the
root README under [Sign-in](../README.md#sign-in); this file does not repeat
them.
