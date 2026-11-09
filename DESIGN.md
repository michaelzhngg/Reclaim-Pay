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
