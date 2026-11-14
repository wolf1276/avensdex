# Agent Guide: Landing UI

## Scope

This is a landing-page-only extraction of Debanjannnn/winnr, located at `~/Projects/near-hacks/landing-ui`.

Read `README.md`, `design.md`, and `package.json` before making changes. The design reference documents observed code, including inherited limitations; it is not an upstream design specification.

Do not add backend services, API routes, agent execution, contracts, wallet integrations, databases, workflow pages, credentials, or a `.git` directory unless the user explicitly requests them.

## Structure

- `src/app/page.tsx`: section ordering
- `src/app/layout.tsx`: metadata and bundled Geist Pixel Line font
- `src/app/globals.css`: landing styles and 760px mobile breakpoint
- `src/components/Landing/`: landing sections and reusable motion primitives
- `src/components/Landing/data.ts`: navigation, partners, stats, pillars and use-case copy
- `public/`: landing images and logos
- `next.config.mjs`: static export and workspace root

## Working rules

1. Preserve the original visual identity unless asked to redesign: near-black canvas, pixel typography, violet accents, fine borders and generous spacing.
2. Reuse existing motion primitives and CSS patterns rather than introducing a second UI system.
3. Keep interactive React components marked `"use client"`. Access browser-only APIs in effects or event handlers, not during rendering on the server.
4. Preserve static export compatibility. No runtime cookies, server actions, dynamic API endpoints or server-dependent redirects.
5. Check the installed Next.js documentation in `node_modules/next/dist/docs/` before changing framework behavior.
6. Keep all navigation destinations valid. Removed `/workflow` links now point to `#use-cases`; do not restore dead links.
7. Newsletter submission must remain local-only and explicitly described as a preview. Do not collect or transmit email.
8. Product marketing copy does not imply that agent, wallet, payment or trade features exist here. Never introduce fake success messages suggesting real execution.
9. Preserve asset attribution and do not invent licensing permissions.
10. Edit source files, not `out/`, `.next/` or `node_modules/`.

## Run and validate

Use npm and maintain the lockfile.

```sh
npm ci
npm run dev
npm run typecheck
npm run build
```

`npm run build` creates the static site in `out/`. `npm start` previews it using Python 3 on port 3000. Stop the development server first if it occupies that port.

Manually check desktop and mobile widths, section anchors, image loading, text wrapping, accordion keyboard behavior and newsletter feedback. Check for console errors, unwanted form navigation and unexpected network requests. Review reduced-motion behavior honestly: the inherited implementation does not disable all animations.

Report exactly which checks you ran. Do not claim visual verification based only on typecheck/build success.
