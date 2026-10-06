# Cleaning Platform — System Overview

A working reference for the whole system, written to be read end-to-end by a person or an AI
assistant with no prior context. Edit freely — nothing here is generated or regenerated.

Last updated: 2026-09-07.

---

## 1. What this is

A multi-tenant SaaS for commercial cleaning companies. One deployment serves many cleaning
businesses ("tenants"). Each tenant runs their own sites, staff, clients, rosters, invoices and
compliance records.

Four kinds of people use it:

| Role | Where they work | What they do |
|---|---|---|
| **Admin** (`INTERNAL`) | Web | Runs the business. Sees everything. |
| **Supervisor** (`STAFF` + `staffType=SUPERVISOR`) | Web | Admin minus finance, limited to their assigned companies' sites. |
| **Cleaner** (`STAFF`) | **Mobile app** | Clocks in/out, completes tasks, uploads before/after photos, files incidents. |
| **Client** (`CLIENT`) | Web portal | Sees proof their sites were cleaned, inspection scores, invoices. |

There is also `SUBCONTRACTOR` (staff belonging to an outside company) and a platform-level
`SUPER_ADMIN` who manages tenants themselves.

---

## 2. The three repositories

All three live side by side under `Cleaning/` and all track the `staging` branch.

| Repo | Stack | Size |
|---|---|---|
| `multitenant_cleaning_backend` | Java 17, Spring Boot 3.4.11, JPA **and** MyBatis, Flyway, PostgreSQL, RabbitMQ | 919 Java files · 64 tenant controllers · 115 entities · 118 migrations · 43 test classes |
| `cleaning_frontend` | React 19, TypeScript 5.8 (strict), Vite 7, react-router 7, TanStack Query, axios, Tailwind | 280 source files |
| `primos_enterprise_cleaning` | Flutter 3.x (Dart) | 84 Dart files |

### Running locally

```bash
# Backend — must go through the script, which exports .env before starting Maven.
# Running ./mvnw spring-boot:run directly fails with "Could not resolve placeholder 'JWT_SECRET'".
cd multitenant_cleaning_backend && ./scripts/run-local.sh     # port 9898

# Frontend
cd cleaning_frontend && npm run dev                            # port 98
```

Backend boot takes about a minute: Flyway runs across every tenant schema in turn. That is normal,
not a hang.

Useful commands:

```bash
cd multitenant_cleaning_backend && ./mvnw -o -q test    # 342 tests
cd cleaning_frontend && npx tsc -b                       # typecheck (NOT `tsc --noEmit -p .`)
cd cleaning_frontend && npx vitest run                   # 41 tests
cd primos_enterprise_cleaning && flutter analyze
```

---

## 3. Multi-tenancy — the thing to understand first

**Schema per tenant.** One PostgreSQL database, one schema per cleaning company.

The chain on every request:

1. Client sends header `x-tenant-id` (a domain, e.g. `test1.primosenterprise.com`).
2. Backend looks it up in `tenant_domains` → resolves a schema name.
3. `TenantContext` (a ThreadLocal) holds it for the request.
4. Both JPA and MyBatis are pointed at that schema for the duration.

Consequences worth knowing:

- In development the frontend sends `VITE_DEV_TENANT_HOST` rather than the page origin. If you call
  the API by hand with `x-tenant-id: http://localhost:98` you will get 401/404 — use the configured
  dev host.
- `ModuleSeeder` runs on **every boot** and UPSERTs the menu rows into every tenant schema. It is
  the source of truth for which role sees which menu item — a Flyway migration that changes those
  flags will be silently overwritten on the next start.

---

## 4. Authorisation — how it actually works

There are **three** independent gates. All three matter; none is sufficient alone.

1. **Spring Security config** locks four URL prefixes to admins outright:
   `/tenant/finance/**`, `/tenant/staff-payroll/**`, `/tenant/labour-cost-profiles/**`,
   `/tenant/supervisor-salary/**`. Everything else is merely "authenticated".
2. **Per-endpoint checks** in controllers, via `TenantAccessGuard`
   (`requireInternal()`, `requireNotClient()`, `requireSupervisorOrAbove()`, `isClient()`).
   This is where most access control lives, which means a forgotten check is invisible.
3. **The module list** returned by `/tenant/init`. `PrivateRoute` in the frontend builds the set of
   allowed paths from it and redirects anything else to `/403`. Paths not backed by a module must be
   listed in `ALWAYS_ALLOWED_PATHS` or nobody can reach them.

"Supervisor" is **not** a user type. A supervisor is a `STAFF` login whose `Staff` record has
`staffType = SUPERVISOR`. Treating every `STAFF` login as a supervisor would give every cleaner
their manager's powers — several bugs have come from exactly this.

**Supervisor scoping rule:** a supervisor is granted a whole *company* (`supervisor_company`), then
individual sites can be taken back off them (`supervisor_site_exclusion`). Both halves are required.
The canonical implementation is `ChatMapper.isSiteVisibleToUser`.

---

## 5. Key domain concepts

- **Site** — a place that gets cleaned. Belongs to a company (client). Carries a geofence
  (`geo_latitude`, `geo_longitude`, `geofence_radius_meters`) used for clock-in validation.
- **Scope of work** (`site_task`) — the checklist for a site, grouped by area, in four types:
  Regular, Periodical, Rectification, Adhoc.
- **Time shift** (`time_shifts` + `time_shift_entries`) — the roster. **Not** a list of dates: it is
  a repeating cycle. A shift has a `start_date` and `cycle_length_days`; entries sit at a `day_index`
  within the cycle. To decide whether a shift lands on date D:

  ```sql
  tse.day_index = (D - COALESCE(ts.start_date, s.start_date::date)) % ts.cycle_length_days
  ```

  with guards for a zero/negative cycle length and for dates before the shift's start. Copy this
  from `ReportMapper` rather than re-deriving it — two implementations that disagree put the office
  and the client on different pages about when a clean is due.
- **Task execution** (`site_task_execution` + `task_execution_image`) — the record that a task was
  done, with BEFORE/AFTER photos. This is the evidence the client sees.
- **Inspection** (`site_inspection`) — a scored quality check. Only `COMPLETED` ones reach clients.
- **Invoice** — generated per company over a date range, from time worked.

---

## 6. The mobile app

Cleaners barely touch the web app — the staff web dashboard is deliberately just a
"download the app" screen with store links. The app does:

- Clock in / out, geofenced against the site
- Today's tasks and the scope of work
- Before/after photo capture (camera single-shot, gallery multi-select)
- Inspections, with draft autosave — backing out of a half-finished inspection keeps the photos
- Incident reporting
- Toolbox talks, walkthrough videos, e-learning

Android package: `com.primos.app`. iOS bundle: `com.groom.primos.app` (the numeric App Store ID is
not yet set — see Known issues).

---

## 7. Known issues and current state

### ⚠ Read this before trusting any timing in this document

The database host (`63.250.52.70`) and the application host (`test1.primosenterprise.com`) are
**the same machine**. Deployed, the backend reaches Postgres over localhost. From a developer
laptop, every query crosses the internet to that box.

Measured from a laptop on 2026-09-07:

| Measurement | Result |
|---|---|
| ICMP ping to the host | **336 ms average** |
| One query on an open connection | **~300 ms** |
| Connect + query | **~2.9 s** |

So **local timings are inflated by roughly 300 ms per database round trip and mean nothing about
production.** A screen doing 90 round trips takes 28 seconds here and would take well under a second
on the server.

Two consequences:

1. **Never characterise a performance problem from local measurements alone.** Count round trips
   instead — that number is environment-independent and is what actually needs fixing.
2. **N+1 queries are largely invisible in production and glaring locally.** That is a useful
   property: local development is an excellent N+1 detector. It also means the severity ratings on
   the performance fixes below were overstated when first written — the fixes are correct and worth
   having, but the "never returns" behaviour was a laptop symptom, not a customer-facing one.

Observed locally, for reference (divide by ~300 ms to get round trips):

| Endpoint | Local time | Implied round trips |
|---|---|---|
| `/tenant/chat/site/{id}/members` | ~6 s | ~20 |
| `/tenant/chat/site/{id}?limit=1` | ~10 s | ~33 |
| `/tenant/chat/site/{id}` (15 messages) | ~28 s | ~93 |

Ninety round trips to show fifteen messages is still too many and worth fixing — but as a code
quality problem, not an outage.

### Fixed and verified

| What | Was | Now |
|---|---|---|
| Site report generation | Never returned (abandoned at 2.5 min) — one query *per day* in the range, ~250 for 8 months | **7.7 s**, one range query, verified producing a correct 2-page PDF |
| E-learning course creation | **Impossible** — always returned 404 "Course not found" | Works. JPA saved with a deferred sequence INSERT, then MyBatis read it back and found nothing; the exception rolled the whole thing back. Fixed by flushing before the read. |
| Forgot-password enumeration | Revealed whether an account existed | Identical behaviour either way; generic "Invalid or expired code" |
| OTP paste | Pasting the emailed code did **nothing at all** | Fills all four boxes |
| Client could read all 23 users | — | 403 |
| Supervisor could open Staff Payroll and company-wide attendance | — | Blocked, and the buttons are gone |
| Report endpoints had **no permission check at all** | Any token could pull any site's photo report and the whole company's attendance | Guarded |
| Subcontractor logos | Always broken images (bare API path in `<img src>`, behind auth) | Fetched properly, graceful placeholder |
| Phone fields | Accepted emoji and letters — one record is emoji + `rerewrwerwerwerr` | One shared rule, front **and** back |
| Money dates | 8 screens rendered numerically in the *viewer's* locale — invoice due dates, ledger entries, incidents, 2 of them in CSV exports | Always day-first |
| Maintenance record | Live record due `0001-01-01` costing `-$999` | Bounded |
| Add site | Returned you to the list | Opens the site you just created |
| Timesheet paging | 3/6/9/12 only, against 34 pages | 3–96 and **All** |

### Open

- **Chat room is still slow** (~28 s for 15 messages). Two N+1s were removed and an entity graph
  added; it is still doing roughly 90 round trips. Root cause not yet found. Given §7's latency, this
  may partly resolve itself in a co-located environment.
- **`/tenant/site-task-execution` has no authorisation at all.** Any signed-in user can post
  before/after photos to **any** site, attributed to **any** staff member — both `siteId` and
  `staffId` come from the request body and nothing checks the caller. This is the evidence behind
  client reports. Needs a decision: force the staff id from the session for staff logins while
  letting admins record on someone's behalf, plus a site-visibility check.
- **Site report `siteId` is an IDOR** — any staff login can read any site's report by changing the
  number.
- **Secrets were pushed to `origin/staging`** on 2026-09-05 and remain in history (commit
  `eef6592`). Rotation outstanding: DB password, JWT secret, RabbitMQ password, two Google keys.
  **Do not casually rotate `AES_SECRET_KEY`** — staff bank details are encrypted with it and would
  need re-encrypting.
- **iOS App Store link is a placeholder** (`id000000000`). Set `VITE_APP_STORE_URL` once registered;
  the badge is hidden until then rather than pointing at a dead page.
- **Subcontractor logo files 404** — the database records a filename but no file exists. Upload path
  worth checking.
- **Web bundle is heavy** — 1.92 MB and 1.28 MB chunks, for users often on mobile data.
- **Toolbox talk PDF** looks up each attendee's name in its own query.
- **Mobile**: 0 errors, but 23 warnings — several `BuildContext` used across async gaps, the shape
  that crashes when a screen closes mid-request.

### Roadmap — client portal

1. ~~Upcoming cleans~~ — **done**, reads the roster cycle forward 14 days.
2. Site detail + live map with last check-in times. The biggest trust feature; the geofence, live
   location and clock-in data already exist.
3. Pay online + printable invoice. Print is straightforward. Payment needs decisions first: Stripe
   account and keys, card vs bank debit, surcharge handling, what an online payment does to invoice
   status, and whether it writes into the ledger the finance screens read.
4. Notifications — clean completed, invoice due, issue resolved. Firebase is already wired.

---

## 8. Conventions worth following

- **Dates:** display through `formatDisplayDate` in `src/utils/dateUtils.ts`. Never a bare
  `toLocaleDateString()` — it renders in the reader's locale and `9/5/2026` means two different days.
- **Phones:** `requiredPhoneValidation` / `phoneValidation` in `src/utils/validation/phone.ts`, and
  `ValidationPatterns.PHONE` on the backend.
- **Empty states:** distinguish "nothing yet" from "nothing matching your search", and write them in
  the reader's voice — a cleaner does not "publish training".
- **Loading:** requests that are slow or polled should pass `showLoading: false`. The global overlay
  blocks the entire application, so one slow request can take the whole UI hostage.
- **New endpoints:** add the permission check yourself. Only four prefixes are protected by config;
  everything else relies on the controller remembering.
- **Never take a `siteId`, `companyId` or `staffId` from the request body and trust it.** Derive
  scope from the session — `ClientPortalService` / `ClientScopeResolver` is the pattern to copy.
