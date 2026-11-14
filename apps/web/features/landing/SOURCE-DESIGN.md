# Winnr Landing — Design Reference

## Provenance and scope

This document was **derived from the repository's code**, not copied from an upstream design document. No `design.md` was present in the source branch or its available history.

Source: https://github.com/Debanjannnn/winnr

Extracted source commit: `3ba31fd91d8484e725224272bc1fdd7f53f03db2`.

Primary references:

- `src/app/globals.css` — actual landing styles, dimensions and breakpoints
- `src/components/Landing/` — page sections, copy and motion behavior
- `src/app/layout.tsx` — Geist Pixel Line font and page metadata
- `public/` — image and logo assets

This project contains only the landing page. Product claims in its copy describe the original concept, not working wallet, agent, payment or trading functionality in this extraction.

## 1. Visual direction

A dark, editorial AI-agent landing page combining pixel typography, atmospheric purple light, restrained panels and generous negative space.

Key signatures:

- Near-black canvas rather than flat gray cards everywhere
- Geist Pixel Line throughout headings and body text
- Large uppercase hero statement over a cinematic background image
- Small uppercase calls to action with compact rectangular silhouettes
- Thin, low-contrast borders and subtle purple glows
- Oversized statistics, numbered pillars and abstract dotted glyphs
- Scroll-triggered text reveals and slow background parallax

Preserve these characteristics. Avoid replacing the page with a generic dashboard, rounded-pill navigation, bright gradients or heavily shadowed card grids.

## 2. Page composition

Rendered order in `src/app/page.tsx`:

1. `SmoothScroll` — invisible Lenis integration
2. `SiteHeader` — vertically stacked desktop navigation, centered logo, right-hand CTA
3. `Hero` — three-line statement, short description, two calls to action
4. `PartnerStrip` — ecosystem logos with subdued labels
5. `PlatformSection` — two-column introduction and CTA
6. `StatsGrid` — three oversized metrics
7. `Pillars` — section heading followed by three numbered capability cards
8. `Manifesto` — wide statement, faint grid texture and explanatory copy
9. `UseCases` — section introduction plus expandable agent descriptions
10. `SiteFooter` — brand, navigation, newsletter preview and bottom legal-style line

The upstream page did not render its `AgentLab` component. That unused component is excluded here; its former `#labs` navigation entry is removed.

## 3. Color system

These are the effective landing colors, not the unrelated original dashboard palette.

| Purpose | Value |
| --- | --- |
| Main canvas and hero surface | `#080b0c` |
| Lower-page gradient endpoint | `#101018` |
| Footer endpoint | `#050705` |
| Primary text / light button fill | `#f6f5ff` |
| Light-button text | `#0b0d12` |
| Main accent | `#a06bff` |
| Highlighted manifesto text | `#c9b8f6` |
| Main paragraph text | `rgba(246,245,255,.72)` |
| Muted card descriptions | `rgba(246,245,255,.58)` |
| Partner strip caption | `rgba(246,245,255,.48)` |
| Panel borders | `rgba(246,245,255,.08)` |
| Accordion separators | `rgba(246,245,255,.12)` |
| Hero outline | `rgba(160,107,255,.18)` |
| Pillar hover outline | `rgba(160,107,255,.24)` |

The page wrapper layers a `680px × 460px` purple radial glow near `86% 8%` over a dark vertical gradient. Panel backgrounds are almost transparent: `rgba(255,255,255,.008)`.

The global `:root` still contains inherited light-theme variables; those are not the visual specification for `.agent-landing`. Landing selectors explicitly establish the dark palette.

## 4. Typography

Font: `GeistPixelLine`, imported from `geist/font/pixel` and exposed through `--font-geist-pixel-line`. Fallbacks are UI monospace / Geist Mono / monospace.

| Element | Desktop style |
| --- | --- |
| Hero h1 | `clamp(40px, 4.5vw, 62px)`, weight `500`, line-height `1.08`, uppercase |
| Section h2 | `clamp(24px, 2.8vw, 36px)`, weight `500`, line-height `1.18` |
| Manifesto heading | `clamp(30px, 3.8vw, 50px)`, weight `500`, line-height `1.18` |
| Metric values | `clamp(70px, 8vw, 124px)`, weight `430`, line-height `.92`, tracking `-.02em` |
| Pillar headings | `16px`, weight `500`, line-height `1.35` |
| General section copy | `13px`, line-height `1.45` |
| Hero description | `12px`, line-height `1.35`, max-width `360px` |
| Manifesto copy | `17px`, line-height `1.7` |
| Kicker | `11px`, uppercase, tracking `.06em`, purple |
| CTA labels | `11px`, uppercase, weight `750` |
| Footer fine print | `10px`, line-height `1.2` |

Heading line breaks are intentional strings passed to `TextAscend`. Do not flatten them into arbitrary wrapping without reviewing the hero composition. Body copy uses restrained widths and `text-wrap: pretty`; section headings use balanced wrapping.

## 5. Layout and spacing

- Outer desktop padding: `28px 16px 0`.
- Direct header and section width: `min(1320px, calc(100vw - 32px))`, centered.
- Desktop navigation: three grid columns, `1fr auto 1fr`; minimum height `64px`.
- Shared section layout: two equal `minmax(0, 1fr)` columns with `70px` gap.
- Hero minimum height: `max(560px, calc(100svh - 184px))`.
- Hero copy: width `min(760px, 64%)`, padding `56px 24px 56px 48px`.
- Partner strip: `72px` vertical padding; logo-row gap `36px`.
- Stats top margin: `64px`; three equal columns; cells minimum `210px` high.
- Pillar heading top margin: `178px`; card rail starts `40px` below it.
- Pillar cards: minimum width `260px`, minimum height `352px`, padding `30px`, gap `10px`.
- Manifesto: two columns, gap `76px`, minimum height `720px`, top padding `162px`.
- Use cases: top margin `56px`; row separators and `20px` vertical padding.
- Footer: full-bleed relative to outer gutters, three columns, `76px` column gap, padding `62px 88px 22px`.

Major panels use `8px` radii. CTA buttons use `3px` radii. Footer inputs/buttons use `4px` radii. Avoid large soft radii that change the technical/editorial character.

## 6. Section details

### Hero

`public/bg-1.jpg` provides the cinematic background. A dark horizontal overlay keeps left-aligned copy readable. Additional radial lighting and a bottom fade blend the image into the page. The background extends beyond the frame (`inset: -4%`) to allow parallax without exposing edges.

Primary CTA uses purple; secondary CTA is dark with a near-white outline. Both have a minimum height of `36px` and horizontal padding of `17px`.

The `.hero-field` decorative silhouette/mesh markup is currently hidden with `display: none`; the image is the visible artwork.

### Statistics

Three cells share a single outlined container. Values are `$0`, `100%`, and `1 tap`; accompanying text lives in `data.ts`. Small purple dots precede metric labels. Desktop cells have dividing vertical borders.

### Pillars

Three numbered cards: Stay in control, Pay their own way, No blind bets. Centered CSS glyphs are built from repeated radial dots on a `13px` grid, not downloaded illustrations. Visible shapes are a circle, skewed narrow block and clipped hexagonal form.

The circular heading arrows are decorative, not carousel controls.

### Manifesto

A large heading spans both columns. The left-side texture uses a faint `146px` grid. The copy highlights selected words in lavender. Existing ghost-bar spans are hidden; do not assume they are visible charts.

### Use cases

Native `details`/`summary` elements provide expansion. The first entry starts open. A purple plus becomes a minus when expanded. Rows can open independently; this is not an exclusive accordion.

The copy says “Eight agents,” while the current `useCases` array contains six descriptions. This is inherited marketing content, not a specification to invent missing product features.

### Footer

Brand/logo and statement on the left; explore links in the middle; newsletter form on the right. The newsletter is UI-only: submitting a valid email shows a preview notice, with no email sent or stored.

## 7. Responsive behavior

Main breakpoint: `max-width: 760px`.

- Outer gutters reduce to `12px`; direct sections use `calc(100vw - 24px)`.
- Header becomes two columns: logo left, CTA right. The desktop nav is hidden.
- Header CTA becomes `110px` wide with `10px` text.
- Hero minimum height becomes `max(560px, calc(100svh - 150px))`.
- Hero copy padding becomes `48px 20px`; heading becomes `38px` / `1.12` and permits line wrapping.
- Hero actions stack vertically.
- Partners stack into one column with `22px` gaps.
- Shared sections and footer become single-column layouts.
- Stats stack vertically, use `76px` values and `170px` minimum cell height.
- Pillars become a vertical grid, with minimum card height `300px`.
- Pillar heading top margin reduces to `100px`.
- Manifesto loses its fixed minimum height and uses `100px` top padding.
- Use-case top margin becomes `90px`.
- Footer padding becomes `50px 36px 42px`; newsletter controls stack.

These are observed source rules. Test narrow phones rather than assuming breakpoint rules alone guarantee ideal wrapping.

## 8. Motion

Library: Framer Motion. Primary easing: `[0.22, 1, 0.36, 1]`.

- `TextAscend`: each explicit line rises from `110%` within an overflow-hidden mask. Defaults: `1.1s` duration, `.15s` stagger, viewport-once activation.
- `WordReveal`: word-by-word opacity, `10px` vertical translation and `8px` blur; `.6s` duration, `.035s` default stagger.
- `FadeIn`: opacity, `32px` upward travel and `12px` blur; default duration `1.3s`.
- `ParallaxSection`: scroll-linked translation from positive to negative speed; default travel `60px` each way.
- Hero entrance: opacity, `18px` rise, scale `.985 → 1`, `.75s` duration.
- Hero background: scroll-linked scale `1 → 1.08`, vertical offset `0% → 5%`, opacity `1 → .68`.
- Pillar hover: `-6px` lift and purple outline; glyph float cycle `5.5s`.
- Use-case hover: `5px` rightward translation.
- Lenis: duration `1.12`, wheel multiplier `.88`, touch multiplier `1.1`.

The existing reduced-motion CSS suppresses selected transforms/filters, but does not disable every Framer Motion animation or Lenis. Treat full reduced-motion support as a future accessibility improvement, not an already implemented guarantee.

## 9. Assets

- `public/bg-1.jpg` — hero background
- `public/logo-winnr-png.png` — header, footer and browser icon
- `public/logos/*.svg` — partner logos: MetaMask, Polymarket, x402, Venice AI, 1Shot, EIP-7710, Ethereum; the retained asset directory also contains USDC

Use these assets rather than substituting unrelated stock imagery. Partner display data is in `src/components/Landing/data.ts`.

## 10. Extraction adjustments

The original `/workflow` application, backend, database, agent execution code and wallet integrations are excluded. CTAs that previously pointed to `/workflow` now use the existing `#use-cases` section, with labels adjusted to exploration rather than execution. No new workflow screen is introduced.

The site uses Next.js static export and needs no keys, environment variables, application backend or API. Keep future landing changes compatible with that constraint.

## 11. Editing checklist

- Read the affected component and `globals.css` before changing layout.
- Keep the pixel font, dark canvas, thin outlines and purple accent coherent.
- Preserve intentional heading breaks and restrained copy widths.
- Keep section links valid; do not restore links to removed routes.
- Preserve keyboard-operable links, native disclosure behavior and form labels.
- Check mobile overflow, focus visibility, text contrast and motion sensitivity.
- Do not imply that newsletter, agents, payments or wallet actions are functional.
- Run `npm run typecheck` and `npm run build` after changes.
- Verify the page in a browser when changing visual behavior; a build is not a visual test.
