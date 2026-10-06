# Findings — Phases 8-39 (backend-relevant subset), multitenant_cleaning_backend

Continuation of the audit documented in `00-progress.md` and `05-findings.md`. Those two files
plus `../BUGS.md` were read in full before starting this pass, and `git log --oneline` (308
commits) was checked so nothing already fixed gets re-reported. All findings below are
evidence-backed with file/line references from a fresh read of the current code, not inference.

## What's covered / what's not

**Covered with real depth, evidence-backed:** Phase 16 (concurrency), Phase 11 (injection),
Phase 13 (payments/webhooks), Phase 9 (PII), Phase 19 (logging/audit), Phase 20 (error handling),
Phase 22 (secrets), Phase 36 (fraud/SoD), Phase 38 (crypto) — all fully investigated with a
concrete conclusion (finding or confirmed-clean).

**Covered, but shallower than the above:** Phase 15 (DB constraints) — spot-checked the
finance-critical tables (invoice, invoice_payment, finance_ledger_entry, staff_payroll) rather
than all 101 migration files; Phase 39 (business invariants) — found one concrete gap
(payroll) but didn't exhaustively trace every numeric field in the app; Phase 8
(orders/inventory) — the domain turned out to be much smaller than the phase name implies (see
below), so it's "covered" but there wasn't much there to find.

**Not reached at all:** Phase 12 was scoped down by the task itself to "remaining gaps beyond
what BUGS.md already covered, check four specific files" — those four files were checked and are
covered below, but no broader Phase-12 sweep of every upload/download endpoint was done.

**Important context discovered mid-pass:** the working tree currently has an **uncommitted,
in-progress fix for FIN-001** (`Double` → `BigDecimal` on money entities) — see the note at the
very end of this document. It doesn't compile cleanly with the current service layer as-is, so
treat it as WIP, not as something this audit needs to re-flag or that's live anywhere.

---

# Phase 16 — Concurrency / Race Conditions

## RACE-001 — `SupervisorSalary.weeklyAmount` increment/decrement is an unguarded read-modify-write; no `@Version` (HIGH)

**Evidence:** `SupervisorSalaryServiceImpl.java`:
- `increment()` (L64-79): `BigDecimal previous = salary.getWeeklyAmount(); BigDecimal newAmount = previous.add(req.getAmount()); salary.setWeeklyAmount(newAmount); salaryRepo.save(salary);` — classic read, compute in Java, write.
- `decrement()` (L81-99): identical pattern with `.subtract()`.
- `SupervisorSalary.java` — `grep -n "@Version"` → no match. This entity was **not** included in
  the `RACE-01`/V3_53 fix that added `@Version` to `StaffPayroll` (commit `9d7d111`), and predates
  the `Invoice` version column added in `4c217ea`.

**Impact:** Two concurrent adjustments to the same supervisor's weekly salary (e.g. an admin
double-clicks "Save", or two admins process a raise and a correction around the same time) can
both read the same starting `weeklyAmount`, compute independently, and the second `save()`
silently overwrites the first — one of the two adjustments is lost with no error, no conflict
signal, and (unlike Invoice payments) no separate ledger row preserving the true history: the
only record is `SupervisorSalaryLog`, which is written from the *same* `previous`/`newAmount`
values computed in the racing request, so the log entry itself can also be wrong/inconsistent
with the final stored amount.

**Status: VERIFIED** (code read directly; no `@Version` confirmed by grep across the entity
package).

---

## RACE-002 — Staff check-in/check-out has a TOCTOU race that can double-count hours feeding both payroll and client invoicing (HIGH)

**Evidence:** `SiteServiceImpl.checkIn()` (L124-164, `@Transactional`):
- L140/142: reads the current `StaffHour` row for (date, staff, site) via
  `staffHourRepository.getByDateStaffIdAndSiteId(...)`.
- L157-163: deserializes the `checkInOutActivity` JSON blob, and only throws "Already checked in"
  if the **last** entry in that in-memory list has no `outTime`.
- The row is then mutated and saved later in the method (find-or-create pattern, not an atomic
  upsert).
- `StaffHour.java` → `grep -n "@Version"` → no match; no pessimistic lock (`findById`/custom
  query has no `LockModeType` hint) on the read either.
- At Spring/Postgres default `READ_COMMITTED`, `@Transactional` alone does not stop two concurrent
  transactions from both reading "not checked in" before either commits.

**Impact:** A duplicate/retried check-in request (realistic on mobile — flaky connections
routinely trigger client-side retry logic, or a double-tap before the UI disables the button) can
race past the "already checked in" guard and either corrupt the `checkInOutActivity` JSON (two
overlapping "in" entries with no matching "out") or (via the sibling checkout path, same pattern)
produce inconsistent recorded hours. `StaffHour` rows are the direct input to
`StaffPayrollCalcMapper.calcByStaffAndDateRange` (payroll) and `InvoiceMapper`'s hourly billing
queries (client invoicing) — this isn't a cosmetic UI bug, it's a race in the data both what staff
get paid and what clients get billed are computed from.

**Status: VERIFIED** for the absence of locking and the TOCTOU shape of the code; not verified
as an observed incident (would require live concurrent load to trigger).

---

## RACE-003 — `SiteAsset.quantity` update is last-write-wins with no version check (LOW)

**Evidence:** `SiteAssetServiceImpl.update()` (L54-71) takes `req.getQuantity()` as an absolute
new value and overwrites `entity.setQuantity(...)` unconditionally; no `@Version` on `SiteAsset`.

**Impact:** Two concurrent stock-count updates to the same asset (e.g. two staff members updating
inventory during the same shift) will have the second write silently clobber the first with no
warning. Lower severity than RACE-001/002 because this is a plain field overwrite (not an
increment/decrement, so there's no "lost delta" — just "last save wins"), and the asset register
here is a manual count, not an automated consumption-tracking system (see Phase 8 below).

**Status: VERIFIED.**

## Confirmed GOOD — Concurrency

- `Invoice.totalPaid`/`outstanding`/`status` — `@Version` present (`V3_52`, already fixed per
  FIN-002 in `05-findings.md`).
- `StaffPayroll` — `@Version` present (`V3_53`, commit `9d7d111`, `RACE-01`).
- `GlobalExceptionHandler` now has an explicit `OptimisticLockingFailureException` handler
  (returns 409 with a clear "refresh and try again" message) — confirms the `@Version` additions
  are actually wired to a sane client-facing behavior, not just present in the schema.
- No `@Async` usage anywhere in the codebase (grepped fresh this pass, matches the prior audit's
  finding) — the concurrency surface is entirely synchronous HTTP request races, not
  background-job races.

---

# Phase 11 — Injection

## Confirmed GOOD — MyBatis mapper layer has no string-substitution injection surface

This was flagged by the task as "the highest-value unchecked area" (34 mapper files, assumed raw
SQL). On inspection, the assumption doesn't hold — the mapper layer is clean:

**Evidence:**
- All 34 `*Mapper.java` files under `tenant/mapper/` and `superadmin/mapper/` are
  **annotation-based** (`@Select`/`@Update`/`@Insert`/`@Delete`), not XML mappers —
  `find src/main/resources -iname "*Mapper.xml"` → **zero files**.
- `grep -rn '\$\{'` (MyBatis's unsafe string-substitution syntax, as opposed to the safe `#{}`
  bind-parameter syntax) across `src/main/java/com/cleaning/backend/tenant/mapper/` and
  `.../superadmin/mapper/` → **zero matches**.
- No mapper file builds SQL dynamically via `String.format`/`.formatted(`/`StringBuilder` —
  grepped for all three, zero matches in either mapper package.
- No `createNativeQuery`/`createQuery` calls anywhere outside the mapper packages (checked for
  hand-rolled JPQL/native-SQL construction elsewhere in services) — zero matches.
- No JPA repository `@Query(nativeQuery = ...)` built via string concatenation —
  `grep -n "@Query.*+ *\""` across all repositories → zero matches.

**The one place raw JDBC + string concatenation for SQL identifiers genuinely exists** —
`TenantServiceImpl.createTenant()` (`superadmin/service/impl/TenantServiceImpl.java` L57-70,
L93-98) — builds `CREATE SCHEMA IF NOT EXISTS "..."`, `DROP SCHEMA IF EXISTS "..." CASCADE`, and
an `INSERT INTO "<schema>".tenant_users` by concatenating a `schema` variable into the SQL text.
This looks alarming at first glance but is actually safe: `schema` is derived at L57-61 via
`request.getCompanyName().toLowerCase().replaceAll("[^a-z0-9]", "_")` plus a UUID suffix — the
regex strips every character except `a-z0-9` before the value ever reaches SQL, so no injection
metacharacter can survive into the concatenated string regardless of what the admin creating the
tenant types as a company name.

**Status: VERIFIED, GOOD.** The mapper layer — the area the task specifically called out as
highest-value/unchecked — turns out to be the cleanest part of the codebase from an injection
standpoint. The one raw-SQL-with-concatenation site found is defended by input sanitization at
the point the value is constructed, not by luck.

---

# Phase 13 — Payments / Webhooks Integrity

## N/A — no payment gateway or webhook integration exists in this codebase

**Evidence:** `grep -rliE "stripe|paypal|webhook|payment.?gateway|razorpay|braintree"` across all
of `src/main/java` and `src/main/resources` → **zero matches**.

**Conclusion:** "Payments" in this system means **manually recorded** ledger entries
(`InvoiceServiceImpl.addPayment`, `FinanceServiceImpl.reconcile`/`bulkReconcile`) — an admin/staff
user types in that a payment was received and how, there is no external payment processor, no
webhook endpoint receiving asynchronous payment-confirmation callbacks, and therefore no webhook
signature-verification surface to audit. `addPayment()` itself was already covered under FIN-002
(now fixed with `@Version` + amount validation: not null, `> 0`, `<= outstanding`, invoice not
`CANCELLED`, payment date required — read fresh this pass at L343-421, all present and correct).

**Status: VERIFIED** (absence confirmed by exhaustive grep, not inferred).

---

# Phase 15 — DB Constraints (spot-check of finance-critical tables)

## Confirmed mostly GOOD, with two minor gaps

**Evidence — solid:**
- `invoice` (`V1_1__create_tables.sql` L491-521): `NOT NULL` on `invoice_number`, `company_id`,
  `date_from`/`date_to`, `status`, all three money columns (default 0, not nullable); a
  `CHECK` constraint restricting `status` to the four valid enum values; `FOREIGN KEY (company_id)
  ... ON DELETE RESTRICT` (can't orphan an invoice by deleting its company).
- `invoice_payment` (`V1_16__create_tables.sql` L1-21): `amount NUMERIC(10,2) NOT NULL CHECK
  (amount > 0)` — the DB itself rejects a zero/negative payment even if application code somehow
  didn't; `FOREIGN KEY (invoice_id) ... ON DELETE CASCADE`.
- `invoice_line_item`/`invoice_site`: proper `NOT NULL`+FK combination, `ON DELETE CASCADE` from
  the invoice side, `ON DELETE RESTRICT`/`SET NULL` on the site side as appropriate.

**Gaps found:**
- **`finance_ledger_entry`** (`V1_28__create_finance_ledger.sql` L5-20): `company_id` and
  `site_id` are **nullable** FKs (`BIGINT REFERENCES company(id)` with no `NOT NULL`). Confirmed
  reachable: `ExpenseServiceImpl.processPayment()` only attaches company/site
  `if (dto.getSiteId() != null)`/`if (dto.getCompanyId() != null)` — so a scheduled
  expense/income with neither set produces a financial ledger row attributable to no company and
  no site. Not exploitable, but a real reporting-integrity gap: any per-company/per-site financial
  rollup silently excludes these rows rather than erroring. **Severity: LOW-MEDIUM.**
- **`invoice_payment`'s `ON DELETE CASCADE` on `invoice_id`** is effectively dead code in a way
  worth flagging: `grep -n "deleteById\|\.delete("` across `InvoiceServiceImpl.java`/
  `InvoiceController.java` → zero matches — there is no invoice hard-delete endpoint anywhere
  (only `cancelInvoice`, a status change). So the cascade can never actually fire through the
  app today. Not a live risk, just worth knowing if a future admin/superadmin tooling path ever
  adds a raw-SQL or JPA-repository-level invoice delete — it would silently destroy the payment
  history along with it rather than being blocked. **Severity: informational/LOW.**

**Status: VERIFIED** (all evidence from direct migration-file reads, not inferred from the
entity classes).

---

# Phase 39 — Business Invariants

## INVARIANT-001 — Payroll `save()` trusts client-supplied `amountCalculated`/`totalHours` per site line with no server-side recomputation or cross-check (MEDIUM)

**Evidence:** `StaffPayrollServiceImpl.java`:
- `preview()` (L37-39) is the *only* place that computes real numbers server-side, via
  `calcMapper.calcByStaffAndDateRange(staffId, dateFrom, dateTo)` (reads actual `StaffHour`/rate
  data).
- `save()` (L43-129) takes `req.getSiteLines()` — a list of `PayrollSiteLineDto` straight from the
  request body — and for each one does
  `.totalHours(nz(s.getTotalHours())).amountCalculated(nz(s.getAmountCalculated()))` (L81-82):
  **whatever the client sends is persisted verbatim**, with zero comparison back against what
  `calcMapper.calcByStaffAndDateRange` would produce for the same staff/date range.
- The final `gross` total (L105-109) sums `amountOverride != null ? amountOverride :
  amountCalculated` — so even the "not manually overridden" path is still just echoing a
  client-supplied number, not a server-recomputed one.

**Impact:** The endpoint is now gated to `INTERNAL` users only (see AUTHZ-002's fix, confirmed
current in `StaffPayrollController.java` — `isInternal()` on every method), so this isn't an
external-attacker vector. But it means the system has **no invariant enforcement at all** between
"what the timesheets say this person worked" and "what payroll says they're being paid" — an
admin (malicious, compromised, or simply fat-fingering a number) can submit a payroll site line
with an `amountCalculated` that has no relationship to actual hours/rates, and nothing in the
system — no validation, no reconciliation job (contrast with `InvoiceReconciliationJob`, added in
`888c1d9`, which specifically checks `outstanding == totalInvoiced - totalPaid` daily and logs
divergence) — would ever flag it. There is currently no payroll-side equivalent of that
reconciliation job.

**Status: VERIFIED** (code read directly; confirmed no reconciliation job exists for payroll via
`grep -rln "Reconcil" src/main/java` → only `InvoiceReconciliationJob` and the Finance
bank-reconciliation feature, neither of which touches `StaffPayroll`).

---

# Phase 9 — PII Handling

## PII-001 — Staff Tax File Number and bank account details are stored in plaintext at rest, unlike SMTP passwords which are encrypted (HIGH)

**Evidence:** `Staff.java` (L41-54): `tfn`, `bankAccountNumber`, `bankAccountName`, `bankBsb`,
`superannuationNumber`, `abn` are all plain `String` columns with **no** `@Convert` encryption
annotation and no application-layer encrypt/decrypt call anywhere in the write/read path
(`StaffProfileServiceImpl` — confirmed via `grep -rn "AesEncryptionDeCryption"` across
`tenant/service/impl/`: only `TenantMailSenderFactory` uses it, for tenant SMTP passwords).

For context on what "encrypted" looks like elsewhere in this codebase: SMTP passwords for
per-tenant email sending **are** encrypted at rest via `AesEncryptionDeCryption` (AES-GCM, and per
Phase 38 below, correctly using a random IV as of the current code) — so the team has already
built and uses an encryption utility for exactly this class of secret, it just wasn't applied to
staff financial/tax PII.

**Impact:** A Tax File Number is one of the most sensitive PII identifiers in Australia (used
for identity theft, tax fraud, functionally equivalent to a US SSN in sensitivity), alongside bank
account numbers/BSBs. All of it sits in plaintext columns in the tenant schema. Access control to
this data is now properly scoped (`StaffProfileController.canAccess()`, confirmed current: self or
`INTERNAL`-only — the IDOR from `BUGS.md` is fixed), but that only protects against *application-layer*
access — plaintext-at-rest means a database backup leak, a compromised DB credential, an internal
DBA with broad read access, or a future SQL-injection-class bug anywhere in the stack exposes this
data directly with no additional barrier. Given the app already has the encryption
infrastructure built and proven for SMTP passwords, extending it to these five `Staff` columns
would be a comparatively contained fix.

**Status: VERIFIED** (entity fields and absence of any encryption call read directly).

## PII-002 — Push-notification device tokens logged at WARN/ERROR level (LOW)

**Evidence:** `NotificationServiceImpl.java` L63, L69: `log.error("Failed to send notification to
token {} for tenant {}: {}", ...)` and `log.warn("Invalid FCM token. Deleting token from DB:
{}", deviceToken)` — the raw FCM device token is interpolated directly into the log line.

**Impact:** Device push tokens aren't as sensitive as credentials, but they are
device-identifying and can be used to spam/target push notifications to a specific device if
leaked from logs; low severity but easy to fix (log a truncated/hashed form instead).

**Status: VERIFIED.**

## Confirmed GOOD — PII

- No PII found logged via `logger.info`/`log.info` with request DTOs (`Pojo`/`Req` objects) —
  grepped broadly across `tenant/service/impl` and `tenant/controller`, zero matches for
  full-object logging.
- No password/token/OTP/TFN/bank-field values found in any log statement anywhere in the app
  (grepped case-insensitively for those keywords immediately following a
  `log(ger)?.(info|debug|warn|error)(` call) — the one exception (device tokens, PII-002 above)
  is much lower sensitivity than what the grep was checking for.
- `TenantJwtFilter`'s per-request logging (username/tenant/schema on every call) was already
  correctly downgraded from INFO to DEBUG in `888c1d9` (LOG-001) — confirmed still DEBUG in the
  current file.

---

# Phase 12 — File Upload/Download (the four files named by the task)

## Confirmed GOOD — all four are fixed/hardened as of the current code

The task specifically asked to check whether `FileServiceImpl`, `IncidentManagementServiceImpl`,
`SubcontractorServiceImpl`, and `ChatMessageController` were already touched by prior fixes. They
have been:

- **`FileServiceImpl.java`** (the shared upload/download/delete choke point): `saveFile()` now
  strips path segments from the client filename (`Paths.get(...).getFileName().toString()`, L99),
  containment-checks the resolved write directory against the base upload dir (L84-89, the
  asymmetry noted in `BUGS.md`/fixed by `FILE-01`), and enforces an extension allowlist
  (`assertAllowedExtension`, L38-51, `FILE-02`) — blocks executable/script/HTML/SVG-style uploads.
  `getFile`/`getFilePath`/`deleteFile` all route through `resolveContained()` (L62-74), which
  normalizes and verifies `target.startsWith(base)` before touching the filesystem — `deleteFile`
  now actually **refuses** (L139-142) rather than just logging a warning, closing the gap `BUGS.md`
  flagged.
- **`IncidentManagementServiceImpl.upload()`** (L133): `String original =
  Paths.get(Objects.requireNonNull(file.getOriginalFilename())).getFileName().toString();` — the
  exact sanitization `BUGS.md` said was missing (contrasted with the sibling `editDocument()`
  method) is now present at the upload call site too.
- **`ChatMessageController`** (`uploadChatImage`/`uploadChatFile`, L391-463): same
  `Paths.get(file.getOriginalFilename()).getFileName().toString()` pattern at both upload
  endpoints (L422, L461).
- **`SubcontractorServiceImpl`**: doesn't build file paths itself at all — every upload/download
  (`addLogo`, `uploadDocument`, `getLogo`, `getDocumentFile`) delegates to the shared, now-hardened
  `FileServiceImpl`, so it inherits all of the above automatically.

**Minor residual note (not a new finding, informational):** the allowlist in `FileServiceImpl` is
extension-based only, not magic-byte/content-type verified — a file renamed to end in `.jpg` could
still contain arbitrary bytes. Given the file is served back as a downloaded `Resource` (not
executed server-side, and SVG/HTML/script extensions are excluded from the allowlist so it can't
be opened inline as active content in a browser either), the realistic exploitation path here is
already closed by the extension restriction; adding magic-byte sniffing would be defense-in-depth,
not a fix for a live gap.

**Status: VERIFIED, all four GOOD.**

---

# Phase 8 — Orders / Inventory

## The domain is much smaller than the phase name implies — no orders/purchasing exists

**Evidence:** the only inventory-shaped feature in the app is `SiteAsset`
(`tenant/entity/SiteAsset.java`, `SiteAssetServiceImpl.java`, `SiteAssetController.java`): a manual
per-site register of equipment/supplies with `quantity`/`reorderThreshold`/`condition` fields.
`grep -rn "SiteAsset"` across every other service in `tenant/service/impl/` → **zero matches** —
nothing else in the codebase reads or writes it. There is no purchase order, no supplier/vendor
entity, no automatic quantity deduction on consumption, no receiving/goods-in workflow, and no
link between a cleaning task and asset consumption.

**Conclusion:** this is a flat CRUD asset register, not an orders/inventory system in the sense
Phase 8 usually means (PO lifecycle, stock movements, supplier integrity). The only
concurrency-relevant note is RACE-003 above (last-write-wins on `quantity`, LOW severity, already
covered under Phase 16). No further Phase-8-specific findings apply.

**Status: VERIFIED** (exhaustive grep for cross-references, confirms the feature is isolated).

---

# Phase 19 — Logging / Audit

## AUDIT-001 — The new audit_log trail (commit `888c1d9`) covers only 4 action types; the highest-risk actions in the app — money movement and the exact privilege-escalation fields fixed earlier this audit — are not logged (HIGH)

**Evidence:** `grep -rn "auditLogService\." src/main/java` (excluding the service's own
definition/impl) → exactly 4 call sites, in 3 files:
- `InvoiceServiceImpl.java:459` — `INVOICE_CANCELLED` only.
- `StaffPayrollServiceImpl.java:147,159` — `PAYROLL_MARKED_PAID`/`PAYROLL_MARKED_UNPAID` only.
- `TenantUserServiceImpl.java:248,280` — `USER_DEACTIVATED_SELF`/`USER_REACTIVATED`/
  `USER_DEACTIVATED` only.

**What's missing, cross-checked against what this same audit (and the prior session) identified
as the highest-risk write paths in the app:**
- **`InvoiceServiceImpl.addPayment()`** (L344-421) — recording that money was received against an
  invoice is not audited at all. Only *cancelling* an invoice is logged; adding/removing payment
  records, the actual money-movement events, leave no trail.
- **`TenantUserServiceImpl.updateUser()`** (L78-209) — this is the exact method containing the
  `userTypeChanged`/`staffTypeChanged` admin-only gates that were the subject of the CRITICAL
  privilege-escalation finding fixed earlier this audit (a STAFF user self-promoting to SUPERVISOR
  or binding themselves to a Subcontractor). `grep -n "auditLogService"` inside this file only
  matches the two deactivate/reactivate lines noted above — **changing a user's type or a staff
  member's `staffType` is not audit-logged anywhere**, even though it's precisely the kind of
  sensitive, previously-exploited action an append-only trail exists to catch (an admin's account
  being used to grant an unwarranted role, whether by the admin or by someone who compromised
  their session, would leave zero trace in `audit_log`).
- **`SupervisorSalaryServiceImpl.setSalary()`/`increment()`/`decrement()`** — money changes to a
  supervisor's pay are recorded only in `SupervisorSalaryLog` (a separate, non-audit table with no
  actor/username field at all — `SupervisorSalaryLog.java` has no `actorUserId`/`actorUsername`
  equivalent to what `AuditLog` provides), not in the shared `audit_log` trail alongside every
  other sensitive action.
- **`StaffPayrollServiceImpl.save()`** (creating/editing a DRAFT payroll, including the
  client-supplied amounts flagged in INVARIANT-001 above) is not logged — only the terminal
  mark-paid/mark-unpaid transitions are, so there's no record of what a payroll looked like before
  it was edited pre-payment.
- Invoice **creation**/**update** (as opposed to cancellation) — not logged.

**Impact:** The audit trail added this session is a good start but currently answers "who
deactivated/reactivated a user or cancelled/paid an invoice/payroll" and nothing else — it does
not answer "who changed this person's role," "who recorded this payment," or "who edited this
payroll before it was marked paid," which are the exact questions an append-only trail exists to
answer for a system that handles money and access control. Given the append-only table and service
already exist (`AuditLogService.record(action, entityType, entityId, details)`), extending
coverage to these paths is a small, low-risk addition — the infrastructure just isn't wired to
most of the places that need it yet.

**Status: VERIFIED** (exhaustive grep for all `auditLogService.record(...)` call sites; cross-
referenced against the write paths this audit and the prior session identified as sensitive).

---

# Phase 20 — Error Handling

## Confirmed GOOD — `GlobalExceptionHandler` itself is properly hardened

Read fresh this pass (`common/exception/GlobalExceptionHandler.java`, full file, 80 lines):
`AppException` now returns its own carried status (not blanket 500, fixing the `BUGS.md` finding);
the catch-all `Exception` handler logs server-side via `log.error("Unhandled exception", ex)` and
returns a generic `"Something went wrong. Please try again."` with no exception details to the
client; `OptimisticLockingFailureException` gets a dedicated, clear 409 response (ties back to the
new `@Version` fields from Phase 16). No `ex.printStackTrace()` remains in this file (the
`BUGS.md` Low finding about this specific class is fixed).

## ERR-001 — Login endpoints locally catch broad exception types and echo `getMessage()` straight to the unauthenticated caller, bypassing the safe generic handler (MEDIUM)

**Evidence:**
- `TenantAuthController.login()` L136-140:
  ```java
  } catch (AuthenticationException ex) {
      loginAttemptService.recordFailure(request.getUsername());
      return errorResponse("Authentication failed: " + ex.getMessage(), HttpStatus.UNAUTHORIZED.value());
  } catch (Exception e) {
      return errorResponse("Login error: " + e.getMessage(), HttpStatus.INTERNAL_SERVER_ERROR.value());
  }
  ```
- Same pattern, same two catch blocks, in `AdminAuthController.login()` L59-61.
- `AuthenticationException` is broader than the already-separately-handled `BadCredentialsException`
  (line 128) — it also covers `InternalAuthenticationServiceException`, which Spring Security
  wraps around **any** exception thrown inside `UserDetailsService.loadUserByUsername()` (DB
  connectivity errors, tenant-schema-resolution failures, NPEs from malformed data, etc.), and the
  final bare `catch (Exception e)` catches literally anything else that can go wrong during login.

**Impact:** Both catch blocks return the raw exception message directly in the HTTP response body
to a caller who, by definition, hasn't authenticated yet. This is a local override of the
otherwise-safe `GlobalExceptionHandler.handleGeneralException` (which would return the generic
"Something went wrong" message) — because these controllers catch `Exception` themselves before it
ever reaches the `@ControllerAdvice`. Depending on what underlying failure occurs, this can leak
internal details (a stack-trace-derived message from a DB driver, a null-pointer's class/field
name, an internal service's error text) to an unauthenticated attacker probing the login endpoint —
useful reconnaissance for an attacker (confirms backend framework/library details, internal error
formats, occasionally table/column names from a DB exception).

**Status: VERIFIED** (both controllers read directly; the broader `AuthenticationException` catch
and the generic `Exception` catch both confirmed present in current code).

## ERR-002 — Six `e.printStackTrace()` call sites remain outside `GlobalExceptionHandler` (LOW)

**Evidence:** `grep -rn "printStackTrace"` → `ReportServiceImpl.java` (4 sites: L78, L81, L107,
L165), `SiteManagementExcelServiceImpl.java:54`, `TimeSheetExcelServiceImpl.java:61`.

**Impact:** Lower severity than `ERR-001` — none of these write the exception message into an HTTP
response (checked each surrounding block; they're all report/Excel-generation code paths that
`printStackTrace()` to stdout and then either continue or throw a *new*, generic exception that
does get caught safely upstream). The issue is purely logging hygiene: these bypass the app's
structured logger (no correlation with the rest of the log stream, no log level, writes to stdout
which may or may not be captured/rotated depending on deployment), not a client-facing leak.

**Status: VERIFIED.**

---

# Phase 22 — Secret Scanning

## Confirmed clean

**Evidence:**
- `application.yml`/`application-live.yml`: every credential-shaped value
  (`SPRING_DATASOURCE_PASSWORD`, `SPRING_RABBITMQ_PASSWORD`, `JWT_SECRET`, `AES_SECRET_KEY`) is
  `${ENV_VAR}`-sourced with **no hardcoded fallback** in `application-live.yml` (the `live`
  profile, confirmed to be the one deployed based on file structure). `application.yml` (default
  profile) still has one already-known, already-flagged-in-`05-findings.md` fallback pattern
  (`JWT_SECRET` — actually now checked directly: `secret: ${JWT_SECRET}` with **no** fallback
  either — the hardcoded-fallback issue described in `AUTH-004`/fixed by `5704fcb` appears to be
  fully resolved, not just live-profile-only as `05-findings.md` cautiously left it).
- `application-dev.properties`: only logging-level overrides, no secrets.
- `grep` for AWS-key/Stripe-key/GitHub-token/PEM-header patterns
  (`AIza...`, `sk_live`/`sk_test`, `-----BEGIN`, `xox[baprs]-`, `ghp_...`) across all `.java`,
  `.yml`, `.properties`, `.xml` files plus `Jenkinsfile`/`Dockerfile` → **zero matches**.
- `Jenkinsfile`/`Dockerfile` — no password/secret/token/key strings found.
- The hardcoded Gmail address + plaintext app password in `TenantMailConfig` that `BUGS.md`
  flagged appears to have been superseded — `TenantMailSenderFactory` (the current mail-sending
  path) reads per-tenant SMTP settings from the DB, decrypted via `AesEncryptionDeCryption`
  (L37-53), not a hardcoded config value. `grep -rn "gmail" -i src/main/resources
  src/main/java` found no hardcoded address.

**Bonus/adjacent observation (not strictly Phase 22, flagging since it was noticed while reading
`application.yml`):** `cors.allowed-origins: ${CORS_ALLOWED_ORIGINS:*}` and
`server.servlet.session.cookie.http-only: ${SERVER_SERVLET_SESSION_COOKIE_HTTP_ONLY:false}` both
default to an **insecure** value (wildcard CORS, non-HttpOnly cookie) if the env var is unset in
the default profile — `application-live.yml` requires both with no fallback, so this only matters
if the `live` profile is ever not active in a real deployment, the same caveat already on record as
`AUTH-004`. Not re-verified against infra (Phase 23, out of scope here) — flagged for completeness,
not as a new independent finding.

**Status: VERIFIED.**

---

# Phase 36 — Fraud / Separation of Duties

## SOD-001 — Any non-CLIENT authenticated user can single-handedly create, pay, and cancel the same invoice; Finance has no maker-checker control anywhere, unlike Payroll which now requires INTERNAL for every action (HIGH)

**Evidence:** `InvoiceController.java` — every single endpoint (`POST` create, `PUT` update,
`POST /{id}/payments` addPayment, `POST /{id}/cancel` cancelInvoice, plus every GET) uses the
identical gate:
```java
private boolean isClient() {
    String userType = jwtService.extractUserType();
    return UserTypeEnum.CLIENT.name().equals(userType);
}
```
confirmed at all 11 endpoint methods (L33-142) — `if (isClient()) return unauthorizedResponse();`
and nothing else. This excludes only the `CLIENT` role; every `STAFF`-tier and `INTERNAL` user
passes identically.

**Direct contrast within the same codebase:** `StaffPayrollController.java` (confirmed current,
read fresh this pass) was specifically hardened to `isInternal()` — `UserTypeEnum.INTERNAL.name()
.equals(jwtService.extractUserType())` — on **every** endpoint, with an explicit comment
explaining why ("Previously gated only on 'not CLIENT', which let any STAFF-type login view and
edit any other employee's payroll"). The exact same reasoning was never applied to `Invoice`,
despite Invoice being at least as money-sensitive as Payroll.

**Impact:** A single ordinary `STAFF`-tier login (the lowest non-client tier — e.g. an ordinary
cleaner's account, if compromised or misused) can, unilaterally and without any second approver:
1. **Create** a fabricated invoice against any company in the tenant (`POST /tenant/invoice`).
2. **Record a payment** against it (`POST /tenant/invoice/{id}/payments`) — creating a fake paper
   trail of money received that was never actually received.
3. **Cancel** any real invoice (`POST /tenant/invoice/{id}/cancel`), including ones the same actor
   didn't create.

There is no framework-level role check (per the already-documented AUTHZ-001 architectural gap —
Spring Security authorities are inert; this is the concrete finance instance of that gap), no
requirement that the person who creates an invoice differ from the person who cancels or pays it,
and no reconciliation-side alert for this specific pattern (the existing
`InvoiceReconciliationJob` checks numeric consistency of totals, not who performed which action or
whether the same actor touched both ends of an invoice's lifecycle). This is a textbook
maker-checker gap in exactly the part of the system (money in/out of client accounts) where one
matters most, and the codebase demonstrates the team already knows how to close this class of gap
(Payroll) — it just wasn't applied here.

**Status: VERIFIED** (both controllers read directly and compared side by side).

---

# Phase 38 — Crypto / Data Classification

## Confirmed GOOD — the previously-known AES-GCM zero-IV issue is fixed

**Evidence:** `AesEncryptionDeCryption.java` (full file read, 73 lines):
- `encrypt()` (L33-44): `byte[] iv = new byte[GCM_NONCE_LENGTH]; new SecureRandom().nextBytes(iv);`
  — a fresh cryptographically-random 12-byte IV is generated **every call**, then prepended to the
  returned ciphertext.
- `decrypt()` (L51-71): tries the new random-IV-prefixed format first; falls back to the legacy
  all-zero-IV format (no prefix) specifically so previously-encrypted values (e.g. already-stored
  tenant SMTP passwords) don't need a data migration — a genuinely good backward-compatible fix,
  not a half-measure.
- `git log --oneline -1` on this file → `71f7aeb`, matching the session where the full bug-audit
  pass landed; `git status --short` confirms this file is **not** among the currently-modified
  (uncommitted) files, so this fix is committed and live, not WIP.

This directly resolves the "AES-GCM with a fixed all-zero, never-randomized IV" finding recorded
in `BUGS.md` — that document predates this fix and should be considered stale on this specific
point.

**Other crypto surfaces checked:**
- JWT signing: `JwtService.java` — `Keys.hmacShaKeyFor(secretKey.getBytes())` +
  `signWith(getSigningKey(), SignatureAlgorithm.HS256)`. Standard, appropriate algorithm choice for
  a symmetric-secret JWT setup; no `alg: none` or asymmetric-key-confusion risk found.
- Random-number usage: `grep -rn "new Random\|Math.random\|ThreadLocalRandom"` across all of
  `src/main/java` → **zero matches** anywhere in the codebase — no weak PRNG used for anything
  security-sensitive (the already-known OTP-strength issue, `AUTH-002`, is about the OTP being
  only 4 digits / no rate limiting, not about weak randomness — worth restating that distinction
  since "weak crypto" and "weak OTP policy" are different bug classes and this pass didn't find a
  weak-PRNG instance of the former).
- Password hashing: BCrypt, already confirmed GOOD in `05-findings.md`; re-confirmed unchanged
  this pass.

**Status: VERIFIED, GOOD.** No new crypto findings beyond what's already on record (`AUTH-002`'s
OTP-strength issue, already fixed per the "What's fixed" list).

---

## Note: uncommitted, in-progress FIN-001 remediation found in the working tree

Not a finding — a status observation relevant to anyone continuing this work. `git status --short`
shows 8 modified entity files (`BankTransaction.java`, `FinanceLedgerEntry.java`, `Invoice.java`,
`InvoiceLineItem.java`, `InvoicePayment.java`, `ScheduledExpense.java`, `SubcontractorSite.java`,
`TimeChangeRequest.java`) plus one new untracked migration
(`V3_58__fin001_money_columns_to_numeric.sql`), none of it committed. Spot-checked `Invoice.java`'s
diff: `totalInvoiced`/`totalPaid`/`outstanding` have been changed from `Double` to `BigDecimal` at
the entity level. This is exactly the deferred `FIN-001` fix (`Double` → `BigDecimal` for money
fields) described as "not fixed, not abandoned" in `05-findings.md`, apparently now in progress.

**As of this read, it's incomplete**: `InvoiceServiceImpl.addPayment()` (read fresh during this
pass, L369-375) still does `double newTotalPaid = (invoice.getTotalPaid() == null ? 0.0 :
invoice.getTotalPaid()) + amount;` — plain `double` arithmetic against a getter that (per the
uncommitted entity change) now returns `BigDecimal`, which would not compile as-is. This audit
did not modify anything (out of scope per the task), but flags this clearly so it isn't mistaken
for a live/deployed state: **the current working tree does not compile cleanly** if the entity
changes are real and the service layer hasn't been updated to match. Whoever picks this up next
should finish the service-layer conversion (and the other affected services —
`FinanceServiceImpl`, `ExpenseServiceImpl`, `SupervisorSalaryServiceImpl` uses `BigDecimal`
already and is unaffected) before this can be committed.
