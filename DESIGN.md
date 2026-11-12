# Reclaim Pay design system

Source of truth for colours, type, radius, elevation and motion. Tokens live in `frontend/app/globals.css`; fonts in `frontend/app/layout.tsx`. Shared class recipes (buttons, inputs, cards) are in `frontend/components/ui/styles.ts`, and the app shell (sidebar, top bar, mobile tab bar, drawer) is in `frontend/components/shell/`.

## Direction

A global fintech look in the Stripe and Apple tradition: a marshmallow canvas, white cards with soft layered elevation, generous radii, glass where it helps (navbar, mobile tab bar), and a few dark ink "hero" surfaces with a radial aurora. PayPal blues mark everything to do with the payout rail.

| | Landing | App (employee and HR) |
|---|---|---|
| Feel | Product story for judges and buyers: 3D PayPal payout card, scroll-driven "how it works" flow, live AG Grid triage demo | Working tool for people who handle money: calm, fast to scan, one dark hero card per dashboard at most |
| Motion | framer-motion reveals, scroll-linked flow, three.js card (frameloop on demand) | Hover, focus and purposeful transitions. Nothing loops |

## Colour

Both naming schemes resolve to one palette. App screens use the short semantic names; marketing and shell code also uses the Material-style names.

| Token | Value | Use |
|---|---|---|
| `paper` / `canvas` / `marshmallow` | `#f0f0f0` | Page background |
| `surface` | `#ffffff` | Cards, sheets, dialogs |
| `surface-muted` | `#f4f4f7` | Hover rows, insets, chips |
| `line` | `#e6e6ee` | Hairlines and dividers |
| `line-strong` | `#c2c2d1` | Input and control borders |
| `ink` | `#0b0b1e` | Text and dark hero surfaces (`mesh-ink`) |
| `ink-muted` | `#5c5c72` | Secondary text |
| `accent` = `primary` | `#4647d3` | Brand indigo: main actions, current state |
| `accent-soft` | `#ecebff` | Selected nav item, tinted fills |
| `secondary` / `violet` | `#105bff` | Links in data, focus ring |
| `tertiary` | `#9e00b4` | Aurora and gradient accents only |
| `tangerine` | `#fe8500` | A sparing highlight, never for status |
| `paypal`, `paypal-blue`, `paypal-sky` | `#003087`, `#0070e0`, `#009cde` | The payout rail and the "Pay" in the wordmark |
| `success` / `success-soft` | `#0a7f58` / `#defbe9` | Paid |
| `danger` / `danger-soft` | `#c4153f` / `#ffe3e8` | Blocked or failed |
| `warning` / `warning-soft` | `#b45309` / `#fff3d6` | Needs review |
| `on-ink` | `#ffffff` | Text on `bg-ink` (dark buttons, selected chips) |
| `night` | `#0b0b1e` | Surfaces that stay dark in both themes: `mesh-ink` heroes, skip link |
| `scrim` | `#0b0b1e` | Dialog and drawer backdrops (`bg-scrim/40`) |
| `edge` | `rgb(20 20 43 / 0.1)` | 1 px rim drawn as a box-shadow on buttons and inputs |

## Dark theme

Light, Dark or System, chosen from the moon/sun button in the top bar or Settings > Appearance, saved in `localStorage` (`reclaim-theme`). An inline script in `app/layout.tsx` sets `data-theme` on `<html>` before first paint, and `components/theme/AppearanceProvider.tsx` keeps it in step after that. The marketing page at `/` always renders light.

Every colour token above is redefined for dark in `globals.css`, once under `@media (prefers-color-scheme: dark)` and once under `[data-theme="dark"]`. Saturated colours become light tones and their `on-*` text becomes dark, so `bg-accent text-on-accent` and `bg-ink text-on-ink` work in both themes. `night` and `scrim` stay dark. Shadows go through `--elevation-*` so each theme sets its own.

| Pair | Light | Ratio | Dark | Ratio |
|---|---|---|---|---|
| `ink` on `surface` | `#0b0b1e` on `#ffffff` | 19.43 | `#ededf5` on `#181826` | 15.06 |
| `ink` on `paper` | `#0b0b1e` on `#f0f0f0` | 17.05 | `#ededf5` on `#0f0f1a` | 16.34 |
| `ink-muted` on `surface` | `#5c5c72` on `#ffffff` | 6.50 | `#a6a6bd` on `#181826` | 7.36 |
| `ink-muted` on `surface-muted` | `#5c5c72` on `#f4f4f7` | 5.92 | `#a6a6bd` on `#222233` | 6.55 |
| `accent` on `surface` | `#4647d3` on `#ffffff` | 6.77 | `#9b9cff` on `#181826` | 7.18 |
| `accent` on `accent-soft` | `#4647d3` on `#ecebff` | 5.77 | `#9b9cff` on `#2a2a5c` | 5.42 |
| `on-accent` on `accent` | `#ffffff` on `#4647d3` | 6.77 | `#10102a` on `#9b9cff` | 7.61 |
| `on-ink` on `ink` | `#ffffff` on `#0b0b1e` | 19.43 | `#0f0f1a` on `#ededf5` | 16.34 |
| `secondary` (focus ring) on `surface` | `#105bff` on `#ffffff` | 5.30 | `#7aa2ff` on `#181826` | 7.05 |
| `line-strong` (control border) on `surface` | `#c2c2d1` on `#ffffff` | 1.76 | `#6b6b88` on `#181826` | 3.41 |
| `success` on `success-soft` | `#0a7f58` on `#defbe9` | 4.55 | `#4ed6a0` on `#0f3326` | 7.52 |
| `danger` on `danger-soft` | `#c4153f` on `#ffe3e8` | 4.94 | `#ff8098` on `#3f1420` | 6.60 |
| `warning` on `warning-soft` | `#b45309` on `#fff3d6` | 4.55 | `#f4b04a` on `#3a2a0c` | 7.36 |
| `paypal-blue` on `surface` | `#0070e0` on `#ffffff` | 4.78 | `#5aa8ff` on `#181826` | 7.08 |

`app/globals.theme.test.ts` recomputes the dark ratios and checks the two dark blocks match. Status chips and charts carry a text label next to the colour in both themes.

## HR density

Comfortable or Compact, set next to the theme (HR only), saved as `reclaim-density` and mirrored on `<html data-density>`. Compact switches the AG Grid theme to 36 px rows and tighter padding (`hrGridThemeCompact` in `components/hr-grid/theme.ts`) and tightens plain HR tables. It applies from 768 px up only; phones keep 52 px rows and 44 px targets.

## Type

| Role | Face |
|---|---|
| Headlines (`font-display`, `font-headline`, default on h1 to h3) | Inter Tight, medium to semibold, tight negative tracking on large sizes |
| Body (`font-body`, `font-sans`) | Inter |
| IDs and small amounts in tables (`font-mono`) | JetBrains Mono, always tabular |

Large money figures use the display face with `tabular-nums`, not mono.

## Radius

| Token | Value | Use |
|---|---|---|
| `rounded-control` | 12 px | Inputs, tabs, secondary controls |
| `rounded-full` | | Primary and dark buttons, chips, avatars |
| `rounded-card` | 20 px | Cards and panels |
| `rounded-dialog` | 28 px | Dialogs and sheets |

## Elevation

- `shadow-ambient`: cards. It carries its own 1 px hairline, so cards need no border.
- `shadow-ambient-lg`, `shadow-float`: raised or hero elements.
- `shadow-overlay`: dialogs, menus, popovers, toasts.
- Glass (`.glass-card`, `backdrop-blur`) only on chrome that sits over content: the landing navbar, the top bar, the mobile tab bar.

## Interaction

- `cursor: pointer` on every enabled control and `not-allowed` on disabled ones (base styles in `globals.css`).
- One focus ring: 2 px `secondary` outline, 2 px offset (`:focus-visible`).
- Tap targets at least 44 by 44 px on phones. No horizontal overflow at 390 px.
- Dialogs trap focus, close with Escape and return focus to the trigger. Use native `<dialog>` (see `components/ui/Sheet.tsx`).
- All non-essential motion stops under `prefers-reduced-motion: reduce`.

## Copy

- No em dash in UI text. Empty values read "Not set", never a dash.
- No generic CTAs or buzzwords. Headlines say what happens.
- Speed: "under a minute" only (4 Nov live run: about 40 s from submit to Paid).
- The AI never starts a payment and never rejects a claim. Employees never see risk scores, signal names or HR notes.
