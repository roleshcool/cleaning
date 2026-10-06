# Bug Audit — Full System Pass

Follow-up to `ARCHITECTURE.md`. That pass documented architecture and surfaced bugs as a side
effect; this pass re-read every file in both codebases specifically hunting for bugs, cross-checked
everything previously found against the current code, and verified today's timesheet fixes didn't
introduce anything new. ~800 files re-read across 9 parallel reviews.

Status tags: **[confirmed]** = still present, matches prior finding. **[new]** = found in this pass.
**[fixed]** = no longer present. **[not reproducible]** = prior finding checked and disproven.

---

## Start here — highest-impact items

1. **Cross-tenant authentication bypass** (Critical/Security) — §Backend Critical #1
2. **Invoice GST/total can silently diverge between what's tracked and what's on the PDF sent to the client** (Critical/Money) — §Backend Critical #2
3. **Injury incident reports corrupt their own linked-record IDs on every submission** (Critical, still unfixed from earlier this session) — §Frontend Critical #1
4. **Failed token refresh permanently hangs the UI** (Critical) — §Frontend Critical #2
5. **Shared `Table` component's serial-number column is wrong on every page past page 1** (High, affects nearly every list screen) — §Frontend High #1
6. Two Spring Data repository methods look structurally invalid (`TenantRolesRepository.findByCode`, `IncidentManagementReportSummaryRepo.mainId`) — flagged Critical by static analysis, but the app has booted successfully many times today with this exact code, so treat as **needs runtime verification**, not a confirmed boot-blocker. See §Backend Critical #3.

---

## Backend

### Critical

**1. Cross-tenant authentication bypass.**
`tenant/config/security/TenantJwtFilter.java`, `tenant/config/TenantInterceptor.java`, `tenant/config/TenantHostResolver.java`.
`TenantJwtFilter` resolves which schema to authenticate against purely from client-supplied headers
(`X-Tenant-ID` → `X-Tenant` → `Origin` → `Host`, in that priority — all attacker-controlled), then
loads `UserDetails` for the JWT's username *inside that header-chosen schema*. The JWT does carry a
`tenant` claim, but nothing compares it to the header-resolved schema — `TenantInterceptor` only
checks the claim is non-null, never that it matches. **Scenario**: an attacker with a valid JWT from
Tenant A calls any `/tenant/**` endpoint with `X-Tenant-ID` set to Tenant B's hostname. If a user
with the same username/email exists in Tenant B, the attacker authenticates as that user in Tenant
B — no Tenant B password needed. Breaks the core multi-tenant isolation guarantee.

**2. Invoice GST hardcoded at 10% during creation, but rendered from the tenant's actual configured
rate on the PDF — the two can diverge.**
`tenant/service/impl/InvoiceServiceImpl.java` (`createInvoice`/`updateInvoice`) call
`FinanceUtils.calculateGst()`, which hardcodes `GST_RATE = 10.0`. `InvoicePdfServiceImpl` correctly
reads `tenantDetails.getTaxAmount()` and recomputes GST/subtotal at render time. **Scenario**: a
tenant configured with a non-10% tax rate creates an invoice — the persisted `totalInvoiced`/
`gstAmount` (driving outstanding balance, accounts receivable, payment tracking) uses 10%, but the
PDF actually emailed to the client shows a different total computed from their real rate. The system
tracks one number as owed; the client is billed a different number. Same root cause independently
also affects `FinanceServiceImpl.reconcile` (hardcodes `/1.1`) and `ExpenseServiceImpl.processPayment`
(never computes GST at all) — three different hardcoded/inconsistent GST behaviors across the
finance surface.

**3. Two repository methods that look structurally invalid — needs runtime verification.**
- `tenant/repository/TenantRolesRepository.java`: `findByCode` is declared on
  `JpaRepository<TenantRoles, Long>` but returns `Optional<SuperAdminRoles>` — a different entity
  from a different module.
- `tenant/repository/IncidentManagementReportSummaryRepo.java`: `mainId(Long mainId)` isn't a valid
  Spring Data derived-query prefix and has no `@Query`.

Static analysis says both should fail Spring Data's repository-proxy validation at context startup.
In practice the app has started successfully multiple times today with this exact code in place, so
either these methods are never actually invoked/validated the way expected, or something in this
Spring Boot version's bootstrap is more lenient than assumed. **Don't treat as confirmed
boot-blockers without testing** — but both are real type/signature errors that should be fixed
regardless (they're either dead code that should be removed, or broken code that fails whenever
actually called).

**4. Filename not sanitized on incident-document upload.**
`tenant/service/impl/IncidentManagementServiceImpl.upload()` builds
`System.currentTimeMillis() + "_" + file.getOriginalFilename()` with no sanitization (contrast with
the sibling `editDocument()` method in the same class, which does strip path segments). A crafted
`Content-Disposition` filename containing `../` can write outside the upload directory. Same class
of bug also present in `tenant/controller/ChatMessageController.uploadChatImage`.

### High

**5. `ProfileServiceImpl.updateTenant()` clears the tenant thread-local right before the save that
depends on it.** Not `@Transactional`, so `tenantDetailsRepository.save(...)` on the line right
after `TenantContext.clear()` opens a fresh Hibernate session with no tenant context —
`TenantIdentifierResolver` falls back to schema `public`. **Scenario**: a tenant admin updates
company profile/bank/tax settings — the save either throws (no matching table in `public`) or
silently writes into the shared `public` schema while the tenant's own row is untouched, so the
change appears to silently not save.

**6. Tenant thread-local leak, confirmed in two places.** `NotificationServiceImpl` sets
`TenantContext.setTenantId("public")` mid-method and never restores the caller's tenant; same
pattern found today in `ProfileServiceImpl`. Since `TenantContext` is only cleared in the outer
request filter's `finally`, anything that runs later in the *same request* resolves against the
wrong schema.

**7. `editTimeChange`'s `staffHour` link can silently drop, causing duplicate `StaffHour` rows.**
`TimeChangeRequestServiceImpl.java` — today's fix null-guarded `staff`/`site`, but
`request.setStaffHour(staffHour)` in the same branch is still unconditional. If a client edits an
already-approved ad-hoc row without resending its `staffHourId`, the link drops and the next
approve creates a *second* `StaffHour` for the same shift instead of updating the first. Same class
of bug as the one just fixed; the frontend currently does resend `staffhourid` correctly (per the
frontend review), so this hasn't been observed triggering yet, but it's a latent landmine in the
same method.

**8. Supervisor site-exclusion filter uses the wrong join column — exclusions don't apply.**
`tenant/mapper/CompanyMapper.java` (`getSupervisor`'s `allowed_sites` CTE): the `NOT EXISTS` filter
compares `sse.tenant_user_id = sc.id` (a surrogate PK, not a user id) instead of
`sc.tenant_user_id`, so it almost never matches. **Scenario**: an admin excludes a supervisor from a
specific site; the site still shows up in that supervisor's site list (flagged `isExcluded=true` but
not actually removed).

**9. Hardcoded `WHERE tu.id = 1` in the admin-profile query.** `tenant/mapper/TenantAuthMapper.java`
`getProfile()` takes no parameters and always returns the profile of whichever user has id 1,
regardless of who's actually logged in.

**10. `LeaveRequestServiceImpl.currentUserId()` always returns `null`, and is directly hardcoded at
every call site too** — no audit trail (`requestedBy`/`approvedBy`) is possible for staff leave at
all, confirmed to affect every write path in the service, not just one.

**11. `CompanyServiceImpl.saveSupervisorSite`/`deleteSupervisorSite` are still behaviorally swapped**
relative to their names (save deletes an exclusion, delete creates one) — confirmed unfixed.

**12. Expired/malformed JWTs crash filters instead of returning a clean 401**, in three places:
`TenantInterceptor` (no try/catch around `extractTenant()`, throws `ExpiredJwtException` on every
expired tenant token), `SuperAdminJwtFilter` (same, for `/admin/**`), and
`AdminAuthController.refreshToken`/`JwtService.validateRefreshTokenUsingToken` (NPE on a token
missing the `tokenType` claim, or `MalformedJwtException` on garbage input). All surface as raw 500s
instead of 401s — happens to every user once a day as tokens naturally expire.

**13. `DashboardController.getExpiryAlerts` computes days-until-expiry wrong.** Uses
`today.until(expiryDate).getDays()` (a `Period`, which returns only the day-of-month component, not
a total day count) instead of `ChronoUnit.DAYS.between(...)`. A document expiring in exactly 60 days
reports 0 days left; one expiring in 95 days reports 5. Undermines the whole compliance-alert
feature with essentially random numbers.

**14. `GenerateReportPojo` NPEs whenever a task has photos in only one phase.** Custom setters split
a `",,,"`-delimited string with no null check; `ReportMapper`'s `string_agg` returns SQL `NULL` for
a task with zero images in a given phase (a task still in progress with only before-photos, e.g.) —
routine state, crashes report PDF generation for that date/site.

**15. Missing authorization checks, confirmed across a long list of controllers**: `SupervisorSalaryController`
(anyone can adjust any supervisor's pay), `LeaveRequestController`/`SupervisorLeaveController`
(approve/reject open to anyone), `TimeChangeRequestController`, `SiteInspectionController`,
`SupervisorController`, `InvoiceImportController` (bulk invoice import — also leaks file handles,
`Workbook` never closed), `TenantUserController.toggleStatus` (unlike its siblings, doesn't block
CLIENT), `StaffProfileController` (every endpoint accepts an arbitrary `userId` param with no
ownership check — any authenticated user can potentially read/edit another staff member's bank
details/ID documents by passing a different id).

**16. `ChatController`/`ChatMessageController`**: chat messages accepted from a JWT with no
expiry/tamper check (`extractUsernameUsingToken` without `isTokenValidUsingToken`); image upload
filename not sanitized (path traversal, see #4).

### Medium

- `TenantMailConfig.java` — hardcoded Gmail address + plaintext app password, still in source.
  Rotate and remove regardless of current usage.
- `AesEncryptionDeCryption` — AES-GCM with a fixed all-zero, never-randomized IV. Used to encrypt
  tenant SMTP passwords at rest.
- `AdminUserMapper.getAllUsers()`/`findById()`/`getActiveRole()` — filter on `'STADD'`/`'STAFF'`
  (admin users are actually `INTERNAL`) and query a nonexistent `roles` table — `/admin/users/*`
  endpoints likely broken. Identical `getActiveRole()` bug independently copy-pasted into
  `tenant/mapper/TenantUserMapper.java`.
- `TenantUserRepository.findAllSupervisorsAndAdmin` — missing parentheses around OR/AND means
  `is_active` doesn't filter the INTERNAL branch; deactivated internal admins still appear in
  supervisor/admin pickers.
- `LeaveRequestMapper.findAllFiltered`/`findHeaderById` — three SQL columns all aliased `staffName`
  in one SELECT; MyBatis likely only keeps the last, silently dropping requestedBy/approvedBy names.
- `CompanyServiceImpl.addLogo` — missing a path separator (`"company/" + id + "logo"` instead of
  `.../id + "/logo"`) means old logo files are never actually deleted on replacement; they just
  accumulate on disk forever (`Files.deleteIfExists` silently no-ops on a non-existent/mismatched
  path).
- `TenantServiceImpl.addDocument` — not transactional across a JPA save + raw JDBC update + file
  delete; a failure partway through leaves the tenant record, `tenant_details`, and the filesystem
  inconsistent with each other.
- `superadmin/mapper/TenantMapper.findAll()` uses `LEFT JOIN tenant_domains`, `findById()` uses a
  plain `JOIN` — a tenant with zero configured domains appears in the list but "get by id" silently
  returns null as if it doesn't exist.
- `PasswordEncoderConfig`'s explicit `BCryptPasswordEncoder` bean is never actually wired into either
  `DaoAuthenticationProvider` — login currently works only because Spring Security's
  `DaoAuthenticationProvider` no-arg constructor happens to default to a `{bcrypt}`-aware delegating
  encoder. Fragile: "cleaning up" the unused-looking bean or the `{bcrypt}` prefix would silently
  break login.
- `GlobalExceptionHandler.handleAppException` maps **every** `AppException` to HTTP 500, even though
  it's used throughout for plain business-rule violations that should be 400/403/404 (e.g. "Tenant
  inactive", "Username already in use").
- `FileServiceImpl.saveFile`/`getFile`/`getFilePath` — unsanitized filename/path concatenation
  (upload-side path traversal risk); `deleteFile`'s traversal guard only logs a warning instead of
  aborting.
- `DriveServiceImpl.renameFolder`/`deleteFolder` — disk operation happens before the DB update inside
  one `@Transactional`; a DB failure after a successful disk move/delete leaves DB and filesystem
  permanently out of sync (transaction rollback can't undo a filesystem change).
- `AddUser`/`createTenant` (superadmin) — no `@Valid`/bean validation; a request missing `password`,
  `email`, `companyName`, or `domains` throws an NPE (500) instead of a clean validation error.
- Repeated `tenantDetailsRepository.findAll().get(0)` pattern — dozens of call sites app-wide,
  unguarded `IndexOutOfBoundsException` risk if that table is ever empty.
- Two different `isClient()` idioms (`UserTypeEnum.CLIENT.name().equals(...)` vs raw
  `"CLIENT".equals(...)`) still coexist across ~10 controllers.
- OTP reset flow: the final `/reset-password` step never re-checks `otpValidBefore`, only that the
  rotated `uuid` matches; no rate-limiting on verify/resend; OTP comparison isn't constant-time.
- `SiteServiceImpl.externalApiToSaveLocation` — hardcoded third-party URL, now also confirmed to have
  no timeout and blocks the request thread synchronously (`.block()`) — a slow/hung third party
  stalls every site create/update that includes a location link.
- `MobileController` — several unguarded `Optional.get()` calls (`checkIn`, `push`,
  `getLastLocation`) throw unhandled `NoSuchElementException` if a `TenantUser` has no linked `Staff`
  row.
- Widespread `@OneToOne` used for actually-`@ManyToOne` relationships (`StaffHour`, `TimeShift`,
  `TimeShiftExtra`, `TimeChangeRequest`, `SiteTaskExecution`) — repository-level workarounds already
  prove the real cardinality is many.
- Money stored as `Double` (not `BigDecimal`) throughout `Invoice`/`InvoiceLineItem`/
  `FinanceLedgerEntry`/`BankTransaction` and most of the `finance`/`invoice` DTOs, inconsistent with
  `payroll`/`siteRole`/`staffSite` which correctly use `BigDecimal`.
- `WebsiteConfig`/`SecurityUtilAdmin.skipUrls` entries containing literal `*`/`**` are checked with
  plain `String.startsWith()` in `SuperAdminJwtFilter.shouldNotFilter` (wildcards don't work there),
  while the *same array* is passed to Spring Security's `requestMatchers(...)`, which does understand
  Ant patterns — the two consumers disagree, so "public" paths are still reachable but always hit the
  full JWT filter (and its crash-on-expired-token bug, #12) instead of being skipped as intended.

### Low
- `ex.printStackTrace()` in `GlobalExceptionHandler` bypasses normal logging for every uncaught
  exception app-wide.
- `TenantController.getDocument` returns `200` with an empty body instead of `404` when no logo
  exists.
- ~800 lines of dead, commented-out earlier query versions left in `TimeShiftMapper.java`.
- `TimeShift`/`TimeShiftExtra` share one DB sequence generator name (`time_shifts_seq_gen`) for two
  different tables — likely copy-paste, not currently harmful.
- Duplicated day-of-week pay-rate `CASE` SQL across `InvoiceMapper` (×3), `StaffPayrollCalcMapper`,
  `TimeSheetExcelMapper` — none handle the public-holiday rate the schema otherwise supports.
- `TimeSheetExcelServiceImpl.resolveStaffId` falls back to a `name.hashCode()`-derived synthetic id
  — theoretical collision risk merging two different unlinked staff into one summary row.
- Editing an existing ad-hoc `TimeChangeRequest` can't change its extra-company/site/staff-name/rate
  fields — only settable at creation.

---

## Frontend

### Critical

**1. Injury-type incident reports still corrupt their own linked record IDs — unfixed from earlier
this session.** `tenants/pages/private/incidentManagement/Incident.tsx`, step 4 (injury flow only):
the `IncidentDocuments` success handler calls `setIncidentId(id)` where it should call
`setDocumentId(id)` — overwrites the real incident ID with the newly-created document's ID, and
leaves `documentId` empty. The near-miss flow's equivalent step is correct. Compounding bugs found
in the same wizard this pass:
  - The `localStorage`-sync `useEffect` that persists these ids is missing `documentId` from its
    dependency array (and lists `reporterId` twice) — setting the document id alone never triggers a
    save to `localStorage`.
  - The terminal step (`About`'s `onSuccess`) calls `setAboutId(id)` and `navigate(...)` in the same
    handler, so React swaps the wizard out for `ReportSummary` before the component ever re-renders
    with the new id — `about_id` (and for near-miss reports, `document_id`) likely never gets
    persisted at all for a freshly-completed report.
  - `ReportSummary.tsx`'s id-resolution falls back from the navigated row to whatever is currently in
    `localStorage` — if a list-row doesn't carry the relational ids (typical for a summary DTO),
    opening one incident right after creating another can show/edit/submit the *previous* incident's
    linked records under the new one's context.

  Net effect: every injury-type incident report filed has a real chance of ending up with wrong or
  missing linked-record ids, and the final submission payload can include a bogus `incidentId` /
  `aboutId: 0` / `documentId: 0`.

**2. A failed token refresh permanently hangs any request queued behind it.**
`superadmin/api/apiClients.ts`: concurrent requests hitting a 401 while a refresh is already in
flight get queued as `() => resolve(...)` callbacks. On refresh **success** the queue is flushed; on
refresh **failure** it is never touched — every queued request's promise never resolves or rejects,
hanging forever, and each one had already incremented the global loading counter with no matching
`finishLoading`, so the loading overlay can get stuck on-screen permanently. **Scenario**: a page
fires 2+ parallel calls right as both the access and refresh tokens have expired — the UI freezes
rather than redirecting to login.

**3. `getRowId` collisions for every ad-hoc/"extra" timesheet row.**
`tenants/pages/private/timeSheet/TimeSheet.tsx`: `` `${timeShiftId}_${date}_${staffId}_${siteId}` ``
— rows added via "Add Time Sheet" with "Use extra site"/"Use extra staff" checked have all of
`timeShiftId`/`staffId`/`siteId` null, so two different ad-hoc entries on the same date resolve to
the identical id. Consequences: React key collisions in the card grid and bulk-edit table;
`selectedIds` (bulk selection) can't distinguish the two rows — checking one silently (de)selects
both; `bulkEdits` keyed by this id shares one editable in/out-time slot between two unrelated
entries, so editing one can silently edit or display the other's time. Risk of approving/denying/
editing the wrong ad-hoc shift.

### High

**4. Shared `Table` component's serial-number column is wrong on essentially every list page.**
`components/layout/Table.tsx`: `getSN()` uses an unused local constant `itemsPerPage = 5` instead of
the actual page-size state `rowsPerPage` (default 10, used correctly by the real pagination logic a
few lines away). Any table with more than one page of results at the default page size shows wrong
row numbers from page 2 onward (e.g. "6, 7, 8…" instead of "11, 12, 13…"). `Table` is shared across
nearly every list screen in both the SuperAdmin and Tenant apps.

**5. `encodeData`/`decodeData` route-param helper can corrupt navigation.**
`utils/encodeDecode/encodeDecode.ts`: `.replace("/", "---")` / `.replace("---", "/")` have no `/g`
flag — only the *first* `/` in a base64 payload gets swapped. Base64 output routinely contains
multiple `/` characters. This is used to embed whole objects into route path segments (e.g. company/
site detail navigation) — a leftover un-swapped `/` splits the URL into extra path segments,
breaking the route param. Failure scenario: click a company/site card whose encoded payload happens
to contain 2+ `/` (common) — navigation goes to a malformed URL.

**6. `LoginPage.tsx` briefly (or permanently) shows a false "Tenant Not Active" screen.**
`logoUrl === null` is treated as "this tenant doesn't exist/is inactive," but it's also the value
while the logo fetch is still in flight (the `loading` flag from `useLogo()` is never checked). Every
fresh visit to `/login` shows the error card first, flipping to the real form only once the logo
request resolves — and for any legitimate tenant that simply hasn't uploaded a logo yet, the error
screen never goes away at all, permanently blocking login.

**7. New-supervisor company assignment still uses a raw `fetch()`** bypassing auth headers/tenant
header/refresh interceptor, with a `localhost:9898` fallback that would silently target the wrong
host in a real deployment — and now confirmed to have **no error handling**: if any of the
sequential requests throws, the surrounding success callback aborts before the form resets/
navigates away, even though the user account was already created — admin is stuck on the create
form with no error shown, unsure whether it worked.

**8. Sensitive values still sent as raw query-string params**, confirmed at more call sites this
pass: change-password (both StaffList and UsersManagement flows), forgot-password/verify-otp/
reset-password (new tenant password included).

**9. `TimeAllocation.tsx` — unsorted date selection can corrupt recurring-shift day indexes.**
`selectedDates` is used in the order the date-picker returns selections, not sorted; when no
explicit mapping start date exists, the earliest-picked (not earliest-*dated*) selection becomes the
baseline, and any date at or before that baseline gets its day-offset clamped to 0 — colliding with
the baseline's own entries and overwriting each other's shift data on save.

**10. `ViewCompany.tsx` encodes a differently-shaped object into the URL than what it decodes.** The
saved form uses `companyAddressReqPojo`; the shape read on load expects `companyAddressResPojo`.
After any company edit, the site tab's "Back" button (which reads the mismatched key) silently
redirects to `/dashboard` instead of the company page, and — since the dereference isn't
optional-chained — a matching data-shape drift elsewhere could crash the tab outright.

### Medium

- `InvoicePdfViewerModal.tsx` has no request-cancellation/staleness check — opening invoice A then
  quickly switching to invoice B before A's PDF fetch resolves can let A's late response overwrite
  the already-displayed PDF for B.
- `SiteMap.tsx`/`Map.tsx` — an unmemoized array passed as a `useEffect` dependency tears down and
  reopens the live-tracking WebSocket on every parent re-render, losing position updates during each
  reconnect; stale staff markers aren't pruned when a staff member is unassigned from the site.
- `Map.tsx` — two `//` "comments" sit as literal JSX text nodes (not real comments) directly inside
  `<GoogleMap>`, risking stray rendered text and DOM-reconciliation errors against the Maps SDK's own
  DOM manipulation.
- `SiteList.tsx` — "late check-in" status is computed once at mount (`useMemo(() => new Date(), [])`)
  and never updates; a roster left open past a shift's start time never flips to "not checked in"
  without a manual reload.
- `InvoiceManagement.tsx` — summary tiles on the "Cancelled" invoices view always show $0.00 (they
  re-filter the already-cancelled-only list for non-cancelled rows).
- `ChatRoom.tsx` — pagination is dead (full history refetched every time, `hasMore` forced false
  immediately after first load); blob URLs for staged image previews are never revoked; `.publish()`
  calls have no guard/try-catch for the pre-connection window, and a failure there after a successful
  image upload leaves the image orphaned server-side.
- `EditWork.tsx` — off-by-one lets staff log task work one day before a site's official start date.
- `BankDetailsForm.tsx`/`EmergencyContactForm.tsx`/`OtherDetails.tsx` — call bare `reset()` on save
  success with no refetch, so the form visibly goes blank after a successful save and stays blank
  until the user navigates away and back.
- `ToDoList.tsx` — stored under one fixed `localStorage` key with no per-user scoping; different
  users sharing one browser/machine see each other's to-do items.
- `BankReconciliation.tsx` — the "Include GST" toggle and computed tax breakdown in the import
  preview are entirely cosmetic; the actual import payload never sends `type`/`hasGst`/`taxAmount` to
  the backend (and the backing type doesn't even have fields for them).
- `BudgetsList.tsx` — divide-by-zero when a site's `monthlyBudget` is 0 renders `Infinity%`/`NaN%`
  and breaks the progress bar width.
- `IncidentManagement.tsx` date-range filter mixes UTC-parsed and local-time boundaries — for AU
  users, incidents created in the early hours of the selected "from" date can be silently excluded.
- `CourseList.tsx`/`CoursePlayer.tsx` (eLearning, already known to be fully mocked) — "Enroll Now"
  never actually calls the enrollment mutation; quiz results are never persisted anywhere; course
  progress tabs are hardcoded by course ID regardless of anything the user does.
- Two competing signup pages confirmed: only `Register.tsx` (posts to `/staff/register`) is actually
  reachable at `/signup` per the router; the "real" client self-signup page (`SignUpPage.tsx`,
  `/client/save`) is fully built but dead/unreachable — unclear if that's intentional.

### Low
- `RolePermission.tsx` (both superadmin and tenant copies) — broken non-template string means the
  "Select All" toggle never shows its checked-state color.
- `AdminProfile.tsx` — tax-type label never updates (`onChange` on `<option>` instead of `<select>`).
- `OtpVerificationModal.tsx` — fully built, confirmed still unreferenced anywhere (dead code).
- DOB round-trips through `toISOString()` in two places — can shift the stored date by one day
  depending on browser timezone vs UTC.
- `LogoContext.tsx` — blob URL for the fetched logo is never revoked on refetch (minor leak).
- `ProfileDocumentUpload.tsx` — document-upload mutation has no success toast/refetch; the "existing
  file" preview doesn't refresh until the user leaves and returns to the tab.
- `SiteStaffList.tsx` — plain edit and rate-"increment" open an identically-titled modal
  ("Edit Staff Assignment") despite triggering different backend operations (in-place update vs. a
  new historical rate record) — easy to trigger the wrong one without realizing it.
- `ExpenseManagement.tsx` — stray literal text baked into a Tailwind `className` string (cosmetic).
- `TransactionsList.tsx` — "Export Ledger" button has no click handler.
- `TimeAllocation.tsx` — mapped staff columns render without a `key`, risking React misassigning one
  staff member's times to another's column on reorder.
- `AddIncident.tsx` — empty `catch {}` on the wizard's very first API call, no user feedback on
  failure beyond whatever the interceptor's default toast (if any) does.

### Checked and found *not* to be a live bug this pass
- The `new Date(undefined)` / `format()`-throws crash theorized for ad-hoc timesheet rows with no
  activity yet: on inspection, a genuinely-missing value round-trips through JSON as `null`, and
  `new Date(null)` evaluates to the epoch (a *valid* Date), not an Invalid Date — so `format()`
  wouldn't actually throw via this path. The adjacent `getRowId`-collision bug (Critical #3 above) is
  real and doesn't depend on this mechanism; treat the crash claim as unconfirmed unless you can
  reproduce it with a concrete payload shape.
- `IncidentManagementController`'s `submit/{id}` mapping missing a leading slash — Spring's path
  combination always inserts exactly one separator regardless; this resolves correctly and is not a
  routing bug (reverses an earlier finding in `ARCHITECTURE.md`).
- `SuperAdminUser`'s `{bcrypt}`-prefixed password / plain `BCryptPasswordEncoder` bean — login works
  today because `DaoAuthenticationProvider`'s default encoder is `{bcrypt}`-aware, not because of any
  explicit wiring (see Backend Medium, this is fragile but not currently broken).

---

## What changed since `ARCHITECTURE.md`

Fixed this session: the timesheet-edit crash (`TransientPropertyValueException` on null
staff/site ids), the ad-hoc `staffhourid` link being silently dropped in `time_change_data_extra`.
Both were re-verified correct by this pass, with one adjacent fragility noted (Backend High #7).

Everything else listed above as "confirmed" was present in `ARCHITECTURE.md` and is still present
today; everything marked "[new]" or without that tag in context is newly found in this pass.

---

## Bug Audit — Subcontractor & Toolbox Talk feature pass (2026-08-14)

Follow-up to the pass above. Between that pass (backend `71f7aeb`, frontend `22f4921`) and today, two entire
new features shipped (Subcontractor company management + self-service dashboard, Toolbox Talk safety
meetings) plus a batch of smaller fixes — 77 backend files / 38 frontend files, ~5,800 lines, none of it
previously reviewed. Confirmed the top items from the prior pass (cross-tenant auth bypass, invoice GST,
incident-wizard id swap, hung token refresh, `getRowId` collisions, `Table.tsx` row numbers, `encodeDecode`
`/g` flags, `ProfileServiceImpl` tenant-context ordering, `CompanyMapper` exclusion join, hardcoded
`tu.id = 1`, `TenantRolesRepository.findByCode`, `IncidentManagementServiceImpl` filename sanitization,
`LoginPage` loading race) are **all already fixed** and did not need re-flagging.

### Start here — highest-impact items

1. **Privilege escalation via unguarded `staffType`** — any STAFF user can self-promote to SUPERVISOR or
   attach themselves to any Subcontractor. §Backend Critical #1.
2. **`SubcontractorController` has no object-level authorization** — any authenticated user can deactivate,
   reassign, or delete another subcontractor's data by ID. §Backend High #1.
3. **No route-level gating for the SUBCONTRACTOR user type anywhere in the frontend router**, combined with
   an IDOR in the self-service "Add/Edit Worker" flow. §Frontend High #1–#2.
4. **`isSubcontractorAdmin` is never enforced** — a plain worker has identical authority to their company's
   admin. §Backend High #2.

Items 1–4 together mean the Subcontractor feature currently has no working authorization boundary between
tenant admins, subcontractor companies, and subcontractor workers — worth treating as a single fix-before-
anything-else unit rather than four independent tickets, since they all stem from the same gap (no
ownership/role check was added anywhere along this feature's request paths).

### Backend

**Critical**

1. **Any STAFF user can self-promote to SUPERVISOR, or attach themselves to any Subcontractor, bypassing
   the admin-only "change user type" gate added this session.**
   `tenant/service/impl/TenantUserServiceImpl.java:101-161` (`updateUser`), reachable via
   `PUT /tenant/users/update/{userId}` (`TenantUserController.java:33-39`, blocks only CLIENT — any
   STAFF/INTERNAL caller and any target `userId` pass through). The new admin-only check guards
   `userType` changes only:
   ```java
   boolean userTypeChanged = !user.getUserTypeEnum().equals(userRequestPojo.getUserType());
   if (userTypeChanged && !UserTypeEnum.INTERNAL.name().equals(jwtService.extractUserType())) {
       throw new AppException("Only an admin can change a user's type");
   }
   ```
   but the sibling `staffType` field (SUPERVISOR/STAFF/SUBCONTRACTOR) is a separate, completely unguarded
   write path in the same method (lines 137-161). **Scenario**: a plain STAFF user calls
   `PUT /tenant/users/update/{ownUserId}` sending back their own unchanged `userType: "STAFF"` (so the
   admin gate never triggers) with `staffType: "SUPERVISOR"`, or `staffType: "SUBCONTRACTOR"` plus any real
   `subcontractorId` — the request succeeds with zero admin check, granting SUPERVISOR privileges (unlocking
   every already-unguarded supervisor endpoint from the prior pass — `SupervisorSalaryController`,
   `LeaveRequestController`, etc.) or binding the attacker to an arbitrary subcontractor company.

**High**

1. **`SubcontractorController`/`SubcontractorServiceImpl` have no object-level authorization at all** —
   any authenticated tenant user (including CLIENT and a rival subcontractor's own staff) can read and
   modify any other subcontractor's data by ID. `SubcontractorController.java:32-145` correctly uses
   `resolveCurrentSubcontractorStaff()` for the `/me/*` self-service endpoints, but every ID-driven endpoint
   (`getById`, `update`, `toggleStatus`, `addLogo`, `getLogo`, `getSupervisors`, `getAssignments`,
   `grantSite`/`revokeSite`/`getGrantedSites`, `getDocuments`/`getDocumentFile`/`deleteDocument`) trusts the
   caller-supplied id with no ownership check. **Scenario**: Subcontractor A's own staff login (or any
   CLIENT) calls `PUT /tenant/subcontractor/status/{B's id}` to deactivate rival Subcontractor B,
   `DELETE /tenant/subcontractor/document/{id}` to delete B's compliance certificates, or
   `DELETE /tenant/subcontractor/{B id}/sites/{siteId}` to revoke B's site access. Markedly worse than
   sibling `CompanyController`, which explicitly blocks subcontractor logins via an `isSubcontractor()`
   guard — the same care was never applied here.
2. **`isSubcontractorAdmin` is decorative — the backend never enforces it**, contradicting the feature's
   own documented design (`V3_25__subcontractor_dashboard.sql`: "Anyone else... is a plain worker" and
   site self-assignment is reserved for "the subcontractor's own admin"). Neither
   `TenantUserServiceImpl.addUser/updateUser/toggleStatus` (via `assertCallerCanAccessStaffUser`) nor
   `StaffSiteServiceImpl.validateSubcontractorAssignment` check the flag — only "same subcontractor
   company." The flag is read in exactly one place app-wide (`isMySubcontractorAdmin()`, an informational
   GET). **Scenario**: a plain worker (`isSubcontractorAdmin=false`) can still call
   `POST /tenant/users/create`, `PUT /tenant/users/toggle-status`, and the `StaffSiteController` assignment
   endpoints for their whole company — identical authority to their own admin.

**Medium**

- **Toolbox Talk improvement-action rows lose their id and `createdDate` on every edit.**
  `ToolboxTalkServiceImpl.java:202-205` (`updateImprovements`) clears and fully rebuilds
  `talk.getImprovements()` every save; `applyImprovements` (lines 160-173) never reads
  `ToolboxTalkImprovementReq.getId()` even though the DTO carries one — contrast with
  `updateAttendeesPreservingSignatures` (lines 176-200) in the same class, which correctly matches by id.
  **Scenario**: a supervisor edits a toolbox talk to fix a typo; every existing corrective action is
  destroyed and reinserted with a new id and `createdDate` reset to the edit time — permanently losing when
  a hazard/corrective action was originally raised, which matters for a WHS compliance record.
- **`ToolboxTalkServiceImpl.update()` silently drops site changes** — no `talk.setSiteId(req.getSiteId())`
  anywhere in `update()` (`ToolboxTalkServiceImpl.java:82-101`), so editing a toolbox talk's site returns
  `200 OK` but the talk stays attached to its original site forever.
- **New PaymentType/invoiceRate/fixedAmount fields on ad-hoc timesheet entries are invisible to staff
  payroll.** `StaffPayrollCalcMapper.calcByStaffAndDateRange` (consumed unmodified by
  `StaffPayrollServiceImpl.preview()`, which drafts the real `StaffPayroll` record) still prices every row
  as `hours * staff_site_day_of_week_rate` with zero reference to `payment_type`/`fixed_amount`/
  `invoice_rate`, even though those fields are correctly threaded into `InvoiceMapper` (client billing) and
  `TimeSheetExcelServiceImpl` (the Excel report). **Scenario**: an admin logs a FIXED_AMOUNT ad-hoc entry
  (e.g. $80 supplies reimbursement) against a real staff member — it bills the client correctly, but that
  staff member's payroll preview prices the row as `hours * regular_rate` (often $0), not $80. The admin can
  manually override the line on save, but the number the tool surfaces is silently wrong. Money the client
  is billed and money the staff member is paid can now diverge for these entries — same class of issue as
  the pre-existing Invoice-GST-divergence finding, now in payroll instead of tax.
- **Subcontractor document-expiry reminders broadcast to every user in the tenant, not just admins.**
  `SubcontractorDocumentExpiryReminderJob.java:61-66` → `SendNotificationServiceImpl.save()` →
  `SendNotificationMapper.findAllEmail()` (`select email from tenant_users`, no filter). Emails/pushes
  internal compliance text ("`<doc>` for `<SubcontractorName>` expires on `<date>`") to every client and
  every other subcontractor's staff in the tenant, once per expiring document — leaks which subcontractors
  a tenant uses and their compliance status to that tenant's own clients.
- **Multi-file subcontractor document upload isn't disk/DB atomic** — `SubcontractorServiceImpl
  .uploadDocument()` writes each file to disk then inserts its DB row inside one loop/one `@Transactional`;
  a failure partway through rolls back all DB inserts for the request but leaves the already-written files
  for earlier iterations orphaned on disk. Same class as the already-documented `DriveServiceImpl` issue,
  fresh instance here.
- **Toolbox Talk signature files are never cleaned up** — re-signing (`uploadAttendeeSignature`) always
  writes a new file and overwrites `signaturePath` without deleting the old one; removing an attendee via
  `update()` deletes the DB row (`orphanRemoval=true`) but never the signature file on disk. Same class as
  the already-documented `CompanyServiceImpl.addLogo` leak.
- **`StaffRegistrationServiceImpl.approve()` can't link a newly approved SUBCONTRACTOR-type staff to a
  subcontractor company** — `approve(id, staffType)` sets `staffType` but has no `subcontractorId`
  parameter, so an admin approving a self-registration as SUBCONTRACTOR produces a `Staff` row with
  `subcontractor == null`; the account then fails every `resolveCurrentSubcontractorStaff()` check and has
  no self-service access. No UI path fixes this after the fact — feature-completeness gap, not a security
  issue.

**Toolbox Talk — checked and found clean**: attendee/improvement entities correctly use `@ManyToOne` (not
the app's usual `@OneToOne` smell); PDF generation handles corrupt signature bytes gracefully and correctly
excludes soft-deleted talks; migration FKs/cascades are sound. **Subcontractor — checked and found clean**:
file upload/download goes through the already-sanitizing `FileServiceImpl` (no path traversal, unlike
`IncidentManagementServiceImpl`); the expiry reminder job correctly scopes/clears `TenantContext` per
tenant (does not repeat the `NotificationServiceImpl`/`ProfileServiceImpl` leak); schema FKs/unique
constraints/indexes are sound. **Other reviewed and clean**: invoice PO Number/Reference fields; the
overnight/midnight-crossing shift-hours fix (correctly adds a day per `next_day` across all four duplicated
query blocks, no DST exposure since it's pure date arithmetic); HEIC/HEIF in chat upload + PDF merge (reuses
the already-fixed `ImageStampUtil`, chat upload already had filename sanitization); the "Add Time Sheet
missing from Excel export" fix.

**Low** — a cancel-exclusion filter added to `StaffPayrollCalcMapper`/`TimeSheetExcelMapper` (dropping
admin-cancelled rostered shifts) matches only on `(site_id, date, staff_id)`, not also requiring
`extra_company_id IS NULL` — an unrelated ad-hoc entry sharing the same site/date/staff as a cancelled
roster shift is silently excluded too. Supplementary note on the Reject/Uncancel feature landed this
session, not a primary finding.

### Frontend

**High**

1. **No route-level gate for the SUBCONTRACTOR user type anywhere in `TenantsApp.tsx`.** Every admin route
   (`/subcontractors`, `/subcontractors/:id`, `/users`, `/finance`, `/roles`, `/incident-management`,
   `/staff-payroll`, `/time-sheet`, `/staff-requests`, `/master-configuration`, `/send-notification`,
   `/todo-list`, `/document-creator`, etc.) uses `user?.userType === "CLIENT" ? <Navigate to="/403"/> :
   <Component/>` — none exclude `"SUBCONTRACTOR"`. `LayoutTenants.tsx:39-43` has a comment confirming intent
   ("Subcontractor logins only ever see their own company's dashboard") that's enforced only by hiding
   sidebar links, not in the router. A subcontractor user typing `/users`, `/finance`, or `/subcontractors/7`
   into the address bar reaches the full tenant-admin component tree unless the backend's per-user
   `moduleList` independently restricts them (unverified from the frontend).
2. **Self-service "Add/Edit Worker" trusts the URL's `:subcontractorId`/`:userId` with no ownership check
   (IDOR).** `SubcontractorDashboard.tsx:82,157` navigates to
   `/subcontractors/${id}/supervisors/add-edit(/...)`; `AddEditUser.tsx`/`PersonalInfoForm.tsx` pull both
   ids straight from `useParams()` and send them verbatim with no check they belong to the logged-in
   subcontractor's own company. Combined with #1, a subcontractor admin can edit the URL to create/edit a
   worker under a different subcontractor company's id, or edit a different company's staff member.
3. **Toolbox Talk sign-in silently loses attendee signatures on partial failure, with no user feedback.**
   `ToolboxTalkTab.tsx` `onSubmit` (lines 306-363): each attendee's signature uploads in a follow-up request
   after the meeting saves; any failure is `catch { /* skip */ }`, and the modal still calls
   `onSuccess()`/`onClose()` unconditionally — the admin sees "saved" with a signature silently missing.
   There's also no `catch` around the create/update call itself (the global error-toast interceptor is
   commented out in `apiClients.ts`), and no way to re-sign an existing attendee afterward short of
   delete-and-re-add. Real integrity problem for a WHS compliance record, not cosmetic.

**Medium**

- **Duplicate worker sign-in silently overwrites one attendee's signature with another's** —
  `ToolboxTalkTab.tsx` `addAttendee` (284-298) doesn't filter already-added staff from the picker; the
  upload-matching logic (344-349) matches by `staffId` against a static response snapshot, so two rows for
  the same staff member both resolve to the same saved-attendee entry and the second upload clobbers the
  first, leaving the duplicate row's real signature lost with no error shown.
- **HEIC/HEIF acceptance breaks local preview thumbnails everywhere it was added** (`FileUpload.tsx`,
  `IncidentDocuments.tsx`, `ProfileDocumentUpload.tsx`, `ChatRoom.tsx`, `InspectionTab.tsx`, `SiteReport.tsx`,
  `InvoiceManagement.tsx`, `AdminProfile.tsx`, `AddEditTenants.tsx`): all preview the freshly-picked file via
  `URL.createObjectURL(file)` in a plain `<img>`, which no mainstream non-Safari browser can decode for
  HEIC/HEIF — exactly the format an iPhone photo (the primary real-world trigger for this feature) arrives
  in. Upload still succeeds server-side; the picker just shows a broken-image icon first.
- **Logo/document upload failures in the Subcontractor feature are silently swallowed.**
  `SubcontractorManagement.tsx:124-134` and `SubcontractorDetailsTab.tsx:76-88` upload the logo via a raw
  `apiClient.post` in an empty `catch {}` while the parent save still toasts success;
  `SubcontractorDocumentsTab.tsx:63-81`'s document upload bypasses `useApiMutation` (the source of error
  toasts elsewhere in this same feature) with a bare `try/finally`. None of the three dropzones set
  `maxSize`, so the "Max 5MB" text shown to users isn't enforced anywhere.
- **Subcontractor document expiry badge uses UTC-parsed dates against local "now."**
  `SubcontractorDocumentsTab.tsx:27-33` `expiryStatus()`: `new Date("YYYY-MM-DD")` parses as UTC midnight;
  for AU tenants (UTC+10/+11) a document expiring "today" flips to "Expired" from mid-morning local time —
  10-11 hours early. Same UTC/local mismatch pattern already flagged for `IncidentManagement.tsx`.
- **"Subcontractors" company-management tab is gated only for supervisors, not clients.**
  `CompanyManagemnentTabs.tsx:38-41` adds `"subcontractors"` to the `isSupervisor` exclusion list but not
  any client-equivalent check, while every purpose-built subcontractor route explicitly blocks CLIENT; the
  parent route itself carries no `userType` gate. If a CLIENT can reach it (governed only by server-side
  `moduleList`), they get the tenant-wide subcontractor list plus the ability to grant/revoke that
  subcontractor's access to the client's own sites.

**Low** — `SubcontractorManagement.tsx:67,202` gates "Add Subcontractor" behind `isClient`, but the whole
`/subcontractors` route is already blocked for CLIENT at the router level — unreachable dead code.

**Checked and found clean**: no raw `fetch()`, `encodeData`/`decodeData`, WebSocket, or client-side money
math anywhere in the Subcontractor UI; `tenantOrigin.ts`'s local-dev tenant-resolution fix is complete and
consistent across all four call sites (not a new prod/dev split); `CompanyList.tsx`/`SiteList.tsx`'s
null-`isActive` filter rewrite is correct for all three states; `SignaturePad.tsx` correctly rejects
empty/no-stroke signatures and its `clear()` genuinely resets canvas pixels, not just the visible view; the
new `isSubcontractor` checks in `AuthContext.tsx`/`LayoutTenants.tsx` follow the same pre-existing pattern
already used for `SUPERVISOR`.
