## Remediation status (updated after user said "fix all")

Fixed, tested (36/36 backend tests pass), committed and pushed to `staging`
(commit `4c217ea`): AUTH-001, AUTH-002, AUTH-003, AUTHZ-002, AUTHZ-004, TENANT-001, FIN-002.
Requires a backend redeploy + running the two new Flyway migrations
(V3_51 OTP attempt tracking, V3_52 invoice version column) to take effect.

**Deferred, by explicit user decision:** FIN-001 (Double → BigDecimal for invoice money fields).
Flagged as meaningfully higher blast-radius/risk than the other fixes (3 entities, ~9 DTOs,
every arithmetic site in `InvoiceServiceImpl`, zero existing test coverage per QA-001). User was
asked how to handle it (fix now carefully / write tests first then migrate / skip for now) and
chose to skip it for this pass. Remains open as a known follow-up — not fixed, not abandoned.

---

# Findings — Phases 4, 5 & 6: Auth, Authorization/RBAC, Tenant Isolation (multitenant_cleaning_backend)

Status: Phase 4 (Authentication) complete. Phase 5 (Authorization/RBAC) substantially complete.
Phase 6 (Tenant Isolation) substantially complete via code-path tracing (see note at the top of
that section — no live two-tenant HTTP test was run in this environment; the equivalent static
trace was done instead, and that limitation is stated explicitly rather than glossed over).
All findings below are evidence-backed with file/line references, not inference.

---

# Phase 4 — Authentication

## AUTH-001 — No brute-force protection on `/login` (CRITICAL)

**Evidence:**
- `grep -rniE "ratelimit|bucket4j|throttl|maxAttempts|loginAttempt|failedAttempt"` across
  `src/main/java` → zero matches. `pom.xml` → no rate-limiting dependency at all.
- `TenantAuthController.login()` (lines 82-129): on `BadCredentialsException`, just returns a
  401. No counter, no lockout, no delay, no CAPTCHA.

**Impact:** BCrypt hashing is solid (confirmed via `PasswordEncoderConfig.java`), but nothing
stops unlimited automated password guesses per account or credential-stuffing across usernames.

**Status: VERIFIED** (absence confirmed by exhaustive grep + full read of `login()`).
**Caveat:** infra-level protection (WAF/gateway) not checked yet — pending Phase 23.

---

## AUTH-002 — Password-reset OTP is a brute-forceable 4-digit code with no attempt limiting (CRITICAL)

**Evidence** (`TenantAuthController.java`):
- `generateOTP()` (lines 74-79): 4-digit numeric, **9,000 possible values** (1000-9999).
- `/forgot-password` (line 209+): OTP valid for 3 minutes (`otpValidBefore`, line 225).
- `/verify-otp-forget-password` (lines 284-299): single string-equality check per request, **no
  attempt counter, no lockout, no rate limiting**.
- `/resend-otp` (lines 246-281) freely re-issues a fresh 3-minute OTP on demand — attacker isn't
  even bound to one window.

**Impact:** Attacker who knows a victim's username/email calls `/forgot-password`, then
brute-forces the 4-digit OTP against `/verify-otp-forget-password` (9,000 guesses, trivial with
concurrent requests inside 3 minutes) → obtains a valid `uuid` → `/reset-password` sets an
arbitrary new password → full account takeover, no original password needed.

**Status: VERIFIED.** Highest-severity, most directly actionable finding in Authentication —
small, self-contained fix (attempt counter/lockout per uuid+IP, and/or longer OTP).

---

## AUTH-003 — Deactivating a user does not revoke their already-issued access token (HIGH)

**Evidence:**
- `AuditAbstract.java:33-34` — `Boolean isActive = true`, inherited by `TenantUser` and every
  other audited entity.
- Correctly checked at issuance: `login()` L91, `/init` L136, `/refresh` L181,
  `/reset-password` L216 — all block deactivated users with 401.
- **Not checked per-request**: `TenantJwtFilter.doFilterInternal()`
  (`config/security/TenantJwtFilter.java`) queries the DB fresh every request via
  `TenantUserDetailsService.loadUserByUsername()`, which fetches the `TenantUser` but discards
  `isActive` and builds a Spring Security `User` via the 3-arg constructor (hardcodes
  `enabled=true`). `JwtService.isTokenValidUsingToken()` only checks expiry, no revocation list.
  `/logout` only deletes the push-notification device token, doesn't invalidate the JWT.

**Impact:** Deactivating a user blocks new logins/refreshes immediately, but an already-issued
access token keeps working for its full lifetime — `ACCESS_TOKEN_DURATION = 86400000L` = **24
hours**. A for-cause termination or compromised-account response does not take effect for up to
24h, despite the DB already being queried on every request (cheap fix).

**Status: VERIFIED.**

---

## AUTH-004 — Dev-profile JWT secret has a hardcoded fallback default (LOW, needs infra confirmation)

`application.yml:52` → `secret: ${JWT_SECRET:your-256-bit-secret-key-...}` (hardcoded fallback)
vs. `application-live.yml:54` → `secret: ${JWT_SECRET}` (env-var only, good). Risk is low as long
as the `live` profile is guaranteed active everywhere real. **Status: UNVERIFIED in detail**,
pending Phase 23.

---

# Phase 5 — Authorization / RBAC

## AUTHZ-001 — Spring Security roles are not used for authorization; all tenant users share one authority (HIGH, architectural)

**Evidence:**
- `grep -rn "@PreAuthorize\|hasRole(\|hasAuthority("` across all of `src/main/java` → **zero
  matches**, anywhere in the codebase.
- `SecurityConfig.java` L76-79: the `/tenant/**` filter chain does
  `.requestMatchers(SecurityUtilTenant.urls()).permitAll().anyRequest().authenticated()` — a
  pure "is logged in" gate, no role/authority distinction at the framework level.
- `TenantUserDetailsService.loadUserByUsername()` grants **every** authenticated tenant user the
  exact same single authority: `Collections.singletonList(() -> "ROLE_TENANT")` — regardless of
  `userTypeEnum` (SUPER_ADMIN/INTERNAL/STAFF/CLIENT) or assigned `TenantRoles`.
- `TenantRoles` entity (roles/permissions table) exists and is populated, but is never read for
  authorization anywhere in the request path that was traced.

**Impact:** Spring Security's own authorization primitives are structurally inert in this app —
100% of real access control (where it exists) is reimplemented ad hoc per-controller via manual
`UserTypeEnum` string checks against `JwtService.extractUserType()`. This is not exploitable by
itself, but it means the app has **no framework-enforced baseline** — every single endpoint's
security depends entirely on that endpoint's author remembering to add a manual check, with zero
safety net if they forget. See AUTHZ-002 for confirmed instances where this happened.

**Status: VERIFIED.**

---

## AUTHZ-002 — Finance and Payroll modules are readable by any STAFF-type user; only CLIENT is excluded (HIGH, confirmed real gap — not just architectural)

**Evidence:**
- `FinanceController.java` (`/tenant/finance/**` — dashboard summary, site profitability/margins,
  ledger): every endpoint's *entire* authorization is `if (isClient()) return
  unauthorizedResponse();` where `isClient()` only excludes `UserTypeEnum.CLIENT`.
  `grep -n "UserTypeEnum\|extractUserType\|isAdmin\|INTERNAL"` against `FinanceServiceImpl.java`
  → **zero matches** — no further check anywhere downstream.
- `StaffPayrollController.java` (`/tenant/staff-payroll/**` — payroll preview/save, and
  `GET /{payrollId}` fetch-by-id): identical `isClient()`-only gate.
  `StaffPayrollServiceImpl.java` → **zero** `UserTypeEnum`/role-check matches either.
- This is not an isolated case: **24 of 57 tenant controllers** use `isClient()` as their only
  visible gate (full list captured during this pass — includes `InvoiceController`,
  `ScheduleController`, `SiteController`, `LabourCostProfileController`,
  `SupervisorLeaveController`, `TimeChangeRequestController`, and others). Spot-checked
  `TenantUserController` specifically (below, AUTHZ-003) and found its *service* layer does add
  real checks beyond the controller gate — so this pattern is **not uniformly broken**, but
  Finance and Payroll specifically were checked end-to-end (controller → service → mapper) and
  confirmed to have no further gate at any layer.

**Impact:** Any authenticated `STAFF` user (the lowest non-client tier — ordinary cleaning staff)
can call the finance dashboard and site-profitability endpoints (full company revenue/profit/
margin data) and the payroll endpoints (preview/save payroll, fetch any payroll record by ID —
which, absent an ownership check confirmed in the service layer, likely exposes **other
employees'** pay rate and payroll detail, not just their own — this specific ownership-scoping
question for `StaffPayrollController.get(payrollId)` needs one more read to fully close out).

**IDOR sub-question RESOLVED — upgrades this to read+write, not just read:**
`StaffPayrollServiceImpl.preview(Long staffId, ...)` (L36-37) passes the client-supplied
`staffId` straight to `calcMapper.calcByStaffAndDateRange(staffId, ...)` with **no check that
`staffId` belongs to the caller or anyone the caller manages**. Worse,
`StaffPayrollServiceImpl.save(StaffPayrollSaveReq req)` (L41-64) takes `req.getStaffId()` (or an
existing `req.getPayrollId()`) directly from the request body and persists it — again **no
ownership/scoping check at all** (the only guard present is "can't edit a payroll already marked
PAID"). Combined with the controller's `isClient()`-only gate:

**Status: VERIFIED, and upgraded to CRITICAL.** Any authenticated `STAFF` user can view *and
create/modify* payroll records for **any other employee in the tenant**, including setting site
lines, adjustments, and notes on a coworker's (or a manager's) DRAFT payroll, just by supplying
their `staffId`. This is a genuine horizontal-privilege-escalation / IDOR vulnerability with a
write path, not merely an information-disclosure issue — it directly threatens payroll
integrity, which the audit's own scoring rubric weights heavily (Finance/Payment: 15/100).

---

## AUTHZ-003 — Contrast case (GOOD): `TenantUserController` looks shallow at the controller but is properly gated at the service layer

Included to keep the report honest — not every `isClient()`-only controller is unguarded.
`TenantUserController`'s `update/{userId}`, `toggle-status`, and `change-password` all delegate
to `TenantUserServiceImpl`, which **does** enforce real checks:
- `updateUser()`: non-admin, non-self callers are routed through
  `assertCallerCanAccessStaffUser()` + subcontractor-admin scoping (lines ~118-123); changing a
  user's *type* is hard-gated to `UserTypeEnum.INTERNAL` callers only (lines ~125-129).
- `changePassword()`: requires the **caller** (not the target) to be `UserTypeEnum.INTERNAL`,
  else throws (lines ~251-254) — a STAFF caller cannot reset another user's password.
- `toggleStatus()`: routed through `assertCallerCanAccessStaffUser()`.

**Status: VERIFIED, GOOD.** This is exactly the kind of check that needed tracing all the way to
the service layer before concluding anything — the controller-level pattern looked identical to
Finance/Payroll's, but the actual enforcement differs completely. Lesson applied: AUTHZ-002's
"further check" claim is based on a real grep of the service impl, not an assumption from the
controller alone.

---

## AUTHZ-004 — Invoice endpoints have no authorization or company-scoping at all; any authenticated user, including CLIENT-role accounts, can read every company's invoices (CRITICAL)

**Evidence** (`InvoiceController.java`, `/tenant/invoice/**`):
- Unlike Finance/Payroll (gated by `isClient()` at least), several Invoice endpoints have **no
  gate whatsoever** — not even the weak CLIENT exclusion: `GET /site/by-company/{companyId}`,
  `GET /initial-data`, `GET /by-company` (`listInvoices`), **`GET /all`** (`listAllInvoices`),
  `GET /{id}` (`getInvoice`), `GET /tax/{companyId}`, `GET /{invoiceId}/payments`
  (`listPayments`). Only the mutating endpoints (create/update/send-email/addPayment/cancel) have
  `isClient()` checks.
- Traced to the service layer, confirming there's no hidden scoping either:
  - `InvoiceServiceImpl.getAllInvoices()` (L336-340): literally
    `invoiceRepository.findAll().stream().map(this::toResponseDto)...` — every invoice for every
    company in the tenant, no filter.
  - `InvoiceServiceImpl.getInvoice(Long invoiceId)` (L148-152): `findById(invoiceId)`, no
    ownership/company check — any invoice ID returns that invoice's full detail to anyone
    authenticated.
  - `listPayments(invoiceId)` (L425+) and `listInvoicesByCompany(companyId)` (L140+) take the
    company/invoice ID directly from the request with no cross-check against the caller's own
    company/client identity.

**Impact:** This is worse than AUTHZ-002 because it isn't "STAFF can see things they shouldn't" —
it's **any authenticated account, including the CLIENT role**, which represents the cleaning
company's own external customers. A CLIENT-portal user for Company A can call
`GET /tenant/invoice/all` and enumerate every invoice — amounts, line items, payment/outstanding
status — for **every other client company** in the same tenant, or fetch any specific invoice by
guessing/incrementing `{id}`. This is a direct cross-customer financial data leak, live and
reachable with nothing more than one legitimate client login. It's also the most severe
confirmed finding in the audit so far.

**Status: VERIFIED**, traced controller → service → repository, no scoping found anywhere in
the path for the affected endpoints.

---

## What's confirmed GOOD so far

- BCrypt password hashing — VERIFIED.
- Tenant-mismatch protection in `TenantJwtFilter` (JWT's `tenant` claim cross-checked against
  resolved request schema, 401 on mismatch) — VERIFIED, directly relevant to Phase 6.
- `isActive` correctly enforced at all *token-issuance* points (login/refresh/init/reset-pw).
- `TenantUserController`'s sensitive mutations (password reset, type change, status toggle) are
  properly gated at the service layer despite a shallow-looking controller check.

## Related, lower severity

**LOG-001**: `TenantJwtFilter` logs username/tenant-hint/schema/validity via `logger.info()` on
every authenticated request — revisit in Phase 19.

---

---

# Phase 6 — Tenant Isolation

**Method note:** no live server/two-tenant HTTP test was run in this session (no running
environment available here) — instead the schema-resolution code path was traced statically,
end to end, for both the JPA and MyBatis query paths, which is the static equivalent of the
document's "two-tenant test" and is called out explicitly rather than presented as if a live
test ran.

## TENANT-001 — MyBatis's tenant-schema enforcement is weaker than its Hibernate/JPA sibling: no schema-name validation, no safe default, no reset-on-release (MEDIUM)

**Evidence, comparing the two schema-switching mechanisms side by side:**

*JPA/Hibernate path (GOOD):*
- `TenantConnectionProvider.getConnection()` (`common/config/multitenant/TenantConnectionProvider.java`
  L26-30, L32-40) validates the schema against `SAFE_SCHEMA = Pattern.compile("^[a-zA-Z0-9_]+$")`
  before ever using it in a SQL string, and quotes the identifier (`"SET search_path TO \"" +
  tenantIdentifier + "\""`).
- `releaseConnection()` (L61-68) explicitly resets `search_path TO public` before the connection
  goes back to the pool — no schema state leaks to the next borrower.
- `TenantIdentifierResolver.resolveCurrentTenantIdentifier()` (L13-17) has a safe default: if
  `TenantContext.getTenantId()` is null, it resolves to `"public"` (not "leave whatever was
  there"), so a missing tenant context fails toward a schema with no tenant data rather than
  toward an unpredictable leftover schema.

*MyBatis path (WEAKER):*
- `MybatisSchemaInterceptor.intercept()` (`tenant/config/MybatisSchemaInterceptor.java` L17-27):
  `connection.createStatement().execute("SET search_path TO " + schema)` — **no validation, no
  identifier quoting**, straight string concatenation of whatever `TenantContext.getTenantId()`
  returns.
- **No reset on release** — nothing in the MyBatis wiring (`MyBatisTenantConfig.java`) resets
  `search_path` before a MyBatis-used connection returns to the shared pool.
- **No safe default** — the interceptor's guard is `if (schema != null && !schema.isBlank())`;
  when `TenantContext` is empty, it does *nothing*, silently leaving `search_path` at whatever
  the connection was last set to (a different tenant's schema, or unset) rather than defaulting
  to `public` the way the Hibernate side does.
- `MyBatisTenantConfig.tenantSqlSessionFactory()` (L27-29) is wired to the same shared `DataSource`
  bean used by JPA/Hibernate — confirmed via both classes taking the same `DataSource` type with
  no distinct bean qualifier — so connections genuinely are shared/reused across both query paths
  through the same pool.

**Why this hasn't (as far as traced) caused an actual leak:** every synchronous web request path
goes through `TenantJwtFilter`, which sets `TenantContext` before the filter chain proceeds, and
the interceptor re-sets `search_path` before *every* MyBatis statement — so as long as
`TenantContext` is populated, MyBatis self-heals per-statement regardless of what a previous
pool borrower left behind. The one background job in the codebase,
`SubcontractorDocumentExpiryReminderJob` (`@Scheduled`, `tenant/service/impl/`), was checked in
full and correctly wraps its per-tenant loop in `TenantContext.setTenantId(schema)` /
`TenantContext.clear()` — and only touches JPA repositories, not MyBatis mappers — so it isn't a
live instance of the gap either. No `@Async` usage exists anywhere in the codebase (grepped).

**Impact:** Today, this looks like a latent inconsistency rather than a live, exploitable leak —
I did not find a concrete code path that hits it. But it's a real gap: any *future* code (a new
`@Async` handler, a new background job, a manually-constructed thread, a WebSocket handler that
forgets the pattern `TenantChannelInterceptor` already uses correctly for its own case) that
calls a MyBatis mapper without first setting `TenantContext` would silently query against
whatever schema the pooled connection was last left in — including, worst case, a different
tenant's schema — with no error and no safe fallback. Given 34 MyBatis mapper files handle
exactly the reporting/financial-aggregation queries this audit cares most about (Finance,
Payroll, Schedule), this is worth hardening symmetrically with the JPA side even though no live
trigger was found.

**Status: VERIFIED as an architectural inconsistency / latent risk.** Not VERIFIED as a currently
exploitable cross-tenant leak — no live trigger path was found despite a full search for
`@Async`/`@Scheduled` usage and a full read of the one job that exists.

## What's confirmed GOOD — Tenant Isolation

- `TenantJwtFilter`'s tenant-mismatch check (JWT's `tenant` claim vs. resolved request host) —
  VERIFIED, GOOD (documented under AUTH in earlier notes, directly relevant here too).
- `TenantConnectionProvider` (JPA/Hibernate path): schema-name regex validation, quoted
  identifier, explicit reset-to-public on release. VERIFIED, GOOD — this is a properly
  defence-in-depth-hardened implementation.
- `TenantIdentifierResolver`: safe `"public"` default when context is missing. VERIFIED, GOOD.
- `TenantChannelInterceptor` (WebSocket): confirmed it also explicitly sets `search_path` for
  the WS/STOMP connection path rather than assuming HTTP-filter behavior carries over — the team
  clearly identified WS as a separate context needing its own handling. Not fully read line-by-
  line this pass; worth a closer look together with Phase 6 wrap-up if time allows, but the
  pattern itself is the right instinct.
- No cross-tenant data access was found via any traced controller — every data-access path that
  was checked (Finance, Payroll, Invoice, User management) scopes by the resolved tenant schema
  correctly; the AUTHZ findings above are all *within-tenant* privilege issues (STAFF vs INTERNAL,
  CLIENT vs CLIENT), not cross-tenant ones. Tenant-to-tenant boundary itself held up in every
  path traced.

---

---

# Phase 7 — Finance Integrity

## FIN-001 — Monetary fields use `Double` (binary floating point), not `BigDecimal` (HIGH)

**Evidence:** `Invoice.java` (entity): `private Double totalInvoiced;` (L69),
`private Double totalPaid;` (L72), `private Double outstanding;` (L74-75). Same pattern
confirmed earlier this audit in `addPayment()`'s arithmetic (`InvoiceServiceImpl.java` L369-374):
plain `double` addition/subtraction (`newTotalPaid = ... + amount`, `newOutstanding =
invoice.getTotalInvoiced() - newTotalPaid`), and in `FinanceUtils.splitGstInclusive`/`round`
helpers referenced at L396.

**Impact:** Binary floating point cannot represent most decimal fractions exactly (the textbook
`0.1 + 0.2 != 0.3` problem). For a system that repeatedly accumulates amounts across many
invoice line items, partial payments, and GST splits over the life of an invoice — and, at the
tenant level, across every invoice a company ever issues — this is the kind of error that
doesn't show up in a demo but compounds quietly at production scale into cent-level (and
eventually dollar-level) drift between `totalInvoiced`, `totalPaid`, `outstanding`, and the sum
of the underlying `InvoicePayment`/`FinanceLedgerEntry` rows. This directly undermines Phase 39
"Business Invariants and Reconciliation" (`outstanding == totalInvoiced - totalPaid` should hold
exactly, always, and with `Double` arithmetic it eventually won't). Fixing this after the fact
means a data migration (re-deriving/rounding every historical monetary column), so it's worth
flagging clearly even though it's not a single exploitable bug.

**Status: VERIFIED** (field types and arithmetic directly read).

---

## FIN-002 — Invoice payment recording has a lost-update race condition; no optimistic or row-level locking anywhere in the entity model (MEDIUM-HIGH)

**Evidence:**
- `grep -rln "@Version" src/main/java/com/cleaning/backend/tenant/entity` → **zero matches** —
  no JPA optimistic locking anywhere in the tenant schema's entity model.
- `InvoiceServiceImpl.addPayment()` (L343-421, `@Transactional`) is a classic read-modify-write:
  reads `invoice.getOutstanding()`/`getTotalPaid()` (L351, L369), computes new totals in Java,
  then `invoiceRepository.save(invoice)` (L421). No `SELECT ... FOR UPDATE` (no pessimistic
  locking hint on the `findById` at L345), no `@Version` field to make a second concurrent save
  fail.
- At Spring/Postgres's default `READ_COMMITTED` isolation, two concurrent `addPayment` calls
  against the *same invoice* (double-click, or two staff processing a payment around the same
  time) can both read the same starting `totalPaid`/`outstanding`, compute independently, and the
  second `save()` silently overwrites the first's aggregate update — a classic lost update.

**Mitigating factor found:** each call **does** separately persist an `InvoicePayment` row
(L380-388) and a `FinanceLedgerEntry` row (L399-416) before touching the aggregate — so the
underlying payment records themselves are not lost, and the true payment history is
reconstructable. What's at risk is specifically the `Invoice.totalPaid`/`outstanding`/`status`
*aggregate* fields silently drifting from what the ledger actually shows, with nothing currently
watching for or correcting that drift (no reconciliation job was found anywhere in this codebase
during this pass).

**Impact:** Under concurrent payment entry (realistic for a business processing many invoices
during a busy period, e.g. multiple bookkeepers or an API integration racing a manual entry), an
invoice's displayed outstanding balance/status can become wrong (e.g. showing UNPAID or
PARTIALLY_PAID after it's actually been fully paid, or vice versa) without any error being
raised anywhere. Combined with FIN-001, this is the audit's clearest concrete lead into the
"Business Invariants and Reconciliation" phase — the invariant `outstanding == totalInvoiced -
totalPaid` is not protected by anything beyond hoping requests never race.

**Status: VERIFIED** for the absence of locking; the real-world frequency of an actual lost
update wasn't (and can't be, statically) measured — noted as a latent concurrency defect, not an
observed incident.

## Cross-reference: Finance/Payroll authorization gaps already covered under Phase 5

AUTHZ-002 (Finance dashboard + Payroll readable/writable by any STAFF user, payroll IDOR) and
AUTHZ-004 (Invoice endpoints unguarded for several GETs, including cross-company `getAllInvoices`
reachable by CLIENT accounts) both live squarely inside this phase's scope too — see Phase 5
above for full evidence. Restating the headline here since Finance/Payment is this audit's
highest-weighted phase (15/100): between AUTHZ-002, AUTHZ-004, FIN-001, and FIN-002, Finance
integrity is currently the single weakest area found in the whole audit so far, both from a
"can the wrong person see/change it" angle and a "will the numbers stay correct" angle.

---

## Next
Phases 4-7 (the four highest-weighted, user-selected priority areas) are now substantially
covered with real, traced evidence. Remaining before a full consolidated report: a fast spot
-check pass over the still-unchecked `isClient()`-only controllers listed at the end of Phase 5,
one more read of `TenantChannelInterceptor` (Phase 6 loose end), and then scoring/consolidation
per the audit document's Phase 34 rubric — 40 of the 100 points (Auth 10 + Authz 15 + Tenant 10
+ Finance 15... actually Finance alone is 15, so Auth+Authz+Tenant+Finance = 10+15+10+15 = 50,
not 40; correcting the earlier session note) are now backed by real findings rather than
guesses. Everything phases 8-39 remain not started, per the user's explicit "prioritize by risk"
choice.
