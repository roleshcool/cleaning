# Brag plan — Cord Cleaning (multi-tenant cleaning ops platform)

## Angle
A multi-tenant SaaS for commercial cleaning companies (Spring Boot + React). One deployment
serves many cleaning businesses, each with staff on the ground, sites to manage, and clients
who want proof the work got done. The honest hook is the chaos every cleaning business runs
on — rosters, compliance paperwork, invoices — collapsed into one live, white-labelled system.

## Who it's for / what it does
Four roles, one system: Admin runs the business, Supervisor is admin-minus-finance,
Cleaners clock in/out and upload photos from the field (mobile — out of scope for this cut),
Clients see proof their sites were cleaned. Real, verbatim product copy used throughout
(no invented claims):
- Login tagline: "Access your schedule, manage jobs, and track cleaning tasks effortlessly."
- Client portal tagline: "Your sites, the cleans we've completed with photo proof, inspection
  scores and your invoices — all in one place."
- Real dashboard labels: Total Shifts Today / Active Shifts / Completed / Attention Needed,
  "Live · updated HH:MM:SS", site tabs (All/Active/Not Checked In/Completed/Inactive/No Time
  Data), Staff Document Expiry Alerts, birthday/anniversary HR reminders, Client Service
  Requests awaiting a decision.

## What sets it apart / visual hook
Every tenant gets their own logo and branding on the same login shell (white-label,
multi-tenant) — shown abstractly with generic placeholder marks, not real customers' brands.
The live ops dashboard (real-time site/staff status) and the client-facing photo-proof +
inspection-score portal are the two most concrete, demoable differentiators.

## Real UI reused vs rebuilt
- **Reused live**: the actual login screen (`cleaning_frontend`, real component, real Tailwind
  tokens/fonts), captured by driving the real dev server with Playwright. The tenant logo
  network call is intercepted and fulfilled with a generic placeholder mark (no real tenant
  branding, no backend/auth required).
- **Rebuilt faithfully** (auth + live data aren't reachable in this environment without a
  running backend and a real tenant session, and real staff/client records are treated as
  production PII off-limits for a marketing asset): dashboard stat cards, alert banners,
  and client portal cards, using the exact color tokens, fonts and copy strings from the
  source, with clearly illustrative (not claimed-as-real) sample data.

## Tone
`default` — punchy, playful, clean. 6 scenes, soft (staggered) transitions.

## Visual identity
- Primary blue `#3686c0`, dark navy `#0f2544`/`#0a1a30` (sidebar), success green `#8cef90`,
  background `#f5f5f5`, white cards.
- Alert accent colors straight from the source: amber (expiry), pink (HR), indigo (client
  requests), red/blue/green status chips.
- Fonts: Instrument Sans (headings), Karla (paragraph/body), matching `index.css`.

## Format
Landscape 1920×1080, 30fps, ~20.5s total.

## Storyboard

| # | Scene | Duration | Content |
|---|---|---|---|
| 1 | Hook | 2.5s | Navy bg. Three words punch in fast: "Staff." "Sites." "Money." — the three things every cleaning business juggles. |
| 2 | Reveal (real login) | 3.5s | Real, live-captured login screen. Placeholder tenant mark, real tagline, real form. Type a username, focus password, press Login. |
| 3 | Highlight — live ops | 4.0s | Dashboard reveal: stat cards count up (Total Shifts Today / Active / Completed / Attention Needed), "Live · updated" pulse, site cards stagger in under real tab labels. |
| 4 | Highlight — nothing falls through the cracks | 3.5s | Three real alert banners slide in in sequence: Staff Document Expiry Alerts (amber), birthdays/anniversaries (pink), Client Service Requests (indigo). |
| 5 | Highlight — client trust | 4.0s | Client portal card: real tagline, "Photos on file" stat, inspection-score gauge, a stack of illustrative before/after photo tiles. |
| 6 | Punchline / outro | 3.0s | Cut to navy. Wordmark "Cord Cleaning." One line: "Everything a cleaning business runs on — in one place." Settle on poster frame. |

## Share caption
"Multi-tenant ops for cleaning companies: live site status, staff compliance alerts, and a
client portal with photo-proof + inspection scores — one platform, every business gets its
own front door."
