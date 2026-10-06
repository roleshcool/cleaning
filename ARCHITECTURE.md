# Architecture Notes — Multitenant Cleaning Management SaaS

Generated from a full, file-by-file read-through of both `cleaning_frontend/` (217 TS/TSX files)
and `multitenant_cleaning_backend/` (575 Java files). This is a working reference, not marketing
copy — it documents what the code actually does, including the rough edges.

**Domain**: a SaaS product for Australian commercial cleaning companies to manage clients, sites,
staff, rostering/timesheets, payroll, invoicing/finance, incidents, inspections, chat, and
documents. Two front-ends share one repo: a **superadmin** platform-admin app (manages tenants)
and a **tenant** app (the product each cleaning company actually uses), routed by hostname.

---

## 1. Tech stack

- **Frontend**: React + TypeScript + Vite, TanStack Query, React Hook Form + Zod, Tailwind,
  a mix of hand-rolled components (`components/layout/*`) and shadcn/ui-style Radix primitives
  (`components/ui/*`), `react-google-maps/api`, `@stomp/stompjs` for WebSocket chat/live-tracking.
- **Backend**: Spring Boot (Java), PostgreSQL with **schema-per-tenant** multitenancy, Hibernate/JPA
  *and* MyBatis side-by-side, Flyway migrations, RabbitMQ (email queue), Firebase Cloud Messaging
  (push notifications), Apache POI (Excel), iText7/OpenHTMLToPDF (PDF generation), JWT auth.

---

## 2. High-level architecture

### 2.1 Frontend: one repo, two apps, routed by hostname

`src/main.tsx` → `src/App.tsx` → `utils/helpers.ts:getApp()` picks between:
- `routers/SuperAdmin.tsx` (+ `SuperAdminAuthProvider`) when `window.location.host === VITE_BASE_URL`
- `routers/TenantsApp.tsx` (+ `TenantsAuthProvider`, `LogoProvider`) for every other host (i.e. every
  tenant subdomain falls through to this catch-all)

The subdomain-detection helper (`getSubdomain()`) is fragile — it does
`VITE_BASE_URL.split(window.location.host)[0]`, which only behaves sanely for the exact-match case;
for real tenant hosts it doesn't extract anything meaningful and the app relies on the catch-all
branch rather than genuine parsing.

Both apps are independent `<Routes>` trees with their own `Toaster`, their own `LoadingOverlay`
(shared `LoadingContext` + a tiny pub/sub `loadingBus.ts`), and their own Axios client:

| | Superadmin | Tenant |
|---|---|---|
| Axios base | `VITE_API_BASE_URL + VITE_SUPER_ADMIN_PATH` (`/admin`) | `VITE_API_BASE_URL + VITE_TENANTS_PATH` |
| Tenant identification | n/a | `x-tenant-id` header = **full page origin** (not a real ID) |
| Data hooks | `useApiGet`/`useApiMutation` exist but **no superadmin page actually uses them** — every page does raw `apiClient.get/post/put` + local `useState` | Same generic hooks, and these **are** used throughout the tenant app (though several pages bypass them with raw `tenantApiClient` calls — see Findings) |
| Token storage | `localStorage.accessToken`/`refreshToken` | Same keys — **both apps share the same localStorage keys**, so the two axios clients' 401-refresh flows both read/write the same tokens |

Design system duplication: there are **three overlapping input implementations**
(`layout/Input.tsx`, `ui/input.tsx`, `ui/NiceSelect.tsx`+pickers) and **two Tabs implementations**
(`ui/tabs.tsx` Radix-based, `ui/Tab.tsx` custom). Superadmin pages use the plain `layout/*` kit almost
exclusively; the shadcn `ui/*` kit is mostly exercised by the tenant app.

**The tenant Login/Signup logo** is fetched through the *superadmin* API client
(`GET website/logo?origin=...`), not the tenant client — a legitimate but easy-to-miss cross-app
call needed because there's no tenant-scoped auth yet at that point in the flow.

### 2.2 Backend: one database, one Hibernate EMF, schema-per-tenant

- **One shared datasource and one shared `EntityManagerFactory`**, scanning the entire
  `com.cleaning.backend` package (superadmin + tenant + common entities together).
- Hibernate's `SCHEMA` multitenancy strategy: `TenantConnectionProvider` issues
  `SET search_path TO "<schema>"` on connection checkout (regex-validated schema name) and resets to
  `public` on release. `TenantIdentifierResolver` reads a `ThreadLocal` (`TenantContext`), defaulting
  to `"public"` when unset.
- Every tenant gets an isolated Postgres schema (`<slug>_<uuid8>`), migrated via the **same** Flyway
  scripts (`classpath:db/migration/tenant`) that are *also* applied to `public` — purely so Hibernate's
  boot-time schema validation (which always runs against `public`) doesn't fail against tenant-shaped
  entities.
- **Two independent migration runners** (`TenantFlywayMigrator` via `@PostConstruct`+`@DependsOn`
  before the EMF bean, and `TenantInitializer` via a later `@PostConstruct`) both loop over every
  active tenant and re-run Flyway + module seeding at every boot — redundant but idempotent.
- **Superadmin reads bypass tenant-switching entirely**: a separate MyBatis `SqlSessionFactory`
  (`MyBatisAdminConfig`) has its own interceptor that force-sets `search_path TO public` on every
  statement, independent of `TenantContext`.
- **Module/permission model is duplicated per schema**: `modules` and `role_modules` tables are
  re-seeded in *every* schema (public + each tenant) by `ModuleSeeder`, with hardcoded module rows
  and boolean flags (`isSuperAdminModule/isClientModule/isStaffModule/isSupervisorModule`) controlling
  which UI sees which entry.
- **Two parallel data-access layers**: Spring Data JPA repositories (CRUD, simple queries) and
  MyBatis mappers (`tenant/mapper/*`, `superadmin/mapper/*` — hand-written, often very complex SQL
  with CTEs) that read directly from the schema, bypassing JPA entities almost entirely for
  dashboards/lists/reports. No MapStruct anywhere — DTO↔entity mapping is manual.
- **Security**: two ordered `SecurityFilterChain`s (`/admin/**` via `SuperAdminJwtFilter`,
  `/tenant/**` via `TenantJwtFilter`), each with its own `AuthenticationManager`/`UserDetailsService`.
  Both grant **a single hardcoded Spring Security authority** (`ROLE_SUPERADMIN` / `ROLE_TENANT`)
  regardless of actual user type — all real authorization is done by hand in controllers/services via
  the custom `Module`/`RoleModulePermission` system and JWT `userType` claims, **not** `@PreAuthorize`.
- **Tenant identification for API routing**: the JWT's own `tenant` claim
  (`JwtService.extractTenant()`), resolved against `TenantDomainRepository` by hostname in
  `TenantInterceptor`/`TenantJwtFilter`. WebSocket connections separately trust a client-supplied
  `x-tenant-id` header with much weaker validation (see Findings — Security).

### 2.3 Backend package map

```
com.cleaning.backend
├── common/            shared infra: JPA auditing, security base, multitenancy core,
│                      exceptions, Module/RoleModulePermission entities, FileService, AES util
├── superadmin/        platform admin: Tenant/TenantDomain/SuperAdminUser/SuperAdminRoles,
│                      tenant provisioning, tenant mail/firebase settings
└── tenant/            the actual product domain (480 files):
    ├── config/        firebase, rabbitmq (email), security (JWT), websocket (STOMP chat/tracking)
    ├── controller/     41 REST controllers — the whole tenant API surface
    ├── dto/            147 request/response POJOs across 30 feature folders
    ├── entity/         67 JPA entities
    ├── repository/     63 Spring Data repositories
    ├── mapper/         26 MyBatis mappers (reporting/list queries, raw SQL)
    ├── service/+impl/  77 files — the business logic
    ├── enums/          34 enums (CompanyType, ServiceType, StaffType, statuses, ...)
    └── invoiceMigrate/ one-off Excel bulk-import tooling for onboarding tenants
```

---

## 3. Domain model (entities, by area)

- **Org structure**: `Company` (the tenant's *client*, i.e. the business being cleaned for) →
  `CompanyAddress`, `Site` → `SiteAddress`, `SiteRole` (pay template), `SiteTransferHistory`.
- **Client portal**: `Client` (1:1 `TenantUser`) ↔ `ClientCompany` ↔ `Company`.
- **Identity/auth**: `TenantUser`, `TenantRoles` (M:N), `TenantOtpVerification`,
  `UserNotificationToken`, `WebsiteSettings` (per-user dark-mode), `StaffRegistration`
  (pre-onboarding, self-service).
- **Staff/HR**: `Staff` (1:1 `TenantUser`), `StaffDocument`, `StaffSite` (assignment + rate
  overrides), `StaffHour` (daily clock record, JSON-encoded check-in/out activity),
  live-tracking trio `StaffLiveLocation`/`StaffLocationHistory`/`StaffShiftSession`,
  `TimeChangeRequest` (correction workflow).
- **Rostering**: `TimeShift` (recurring pattern header) → `TimeShiftEntry` (per-cycle-day rule),
  `TimeShiftExtra` (date-specific swap/cancel override), `PublicHoliday`.
- **Leave**: `LeaveRequest` → `LeaveRequestItem` (staff), `SupervisorLeave` (separate, less
  relationally-modeled flow for supervisors).
- **Supervisor access control**: `SupervisorCompany` (company-wide grant),
  `SupervisorSiteExclusion` (site-level carve-out), `SupervisorSalary` + `SupervisorSalaryLog`.
- **Payroll**: `StaffPayroll` → `StaffPayrollSiteLine` + `StaffPayrollAdjustment`.
- **Finance/invoicing**: `Invoice` (M:N `Site`) → `InvoiceLineItem`, `InvoicePayment`,
  `FinanceLedgerEntry` (M:N `BankTransaction` for reconciliation), `ScheduledExpense`,
  `EmailTemplate`, `TenantDetails` (singleton tenant profile/tax config).
- **Incident management**: `IncidentManagementReportSummary` hub with five independent
  `@OneToOne` leaves (`About`, `Details`, `Document`, `InjuredPerson`, `Reporter`) — no back-FK,
  no cascade delete.
- **Site inspections**: `SiteInspection` → `SiteInspectionArea` → `SiteInspectionItem` →
  `SiteInspectionItemPhoto`.
- **Site tasks**: `SiteTask` → `SiteTaskEntry` (template); `SiteTaskExecution` → `TaskExecutionImage`
  (actual before/after evidence) — a deliberate two-layer template-vs-execution split.
- **Chat**: `ChatMessage` (site-scoped, self-referential `replyTo`) → `ChatMessageSeen`.
- **Documents/Drive**: `DriveFolder` (self-referential tree) → `DriveFile`, `DrivePermission`
  (role-based, string principal key — no FK integrity); separate flat `SavedDocument` store for
  the DocumentCreator feature.
- **Misc**: `SendNotification` (broadcast audit), `Todo` (personal task list).

**Recurring modeling smell**: `StaffHour`, `TimeShift`, `TimeShiftExtra`, `TimeChangeRequest`,
`SiteTaskExecution` all use `@OneToOne` for relationships that are semantically `@ManyToOne` (a
staff member clearly has many `StaffHour` rows). The repository layer has its own workarounds
proving this (`StaffHourRepository.getByDateStaffIdAndSiteId` picks a deterministic row specifically
*because* multiple rows exist per date/site).

---

## 4. Frontend feature map (tenant app)

- **Auth**: Login, Signup (**two competing signup pages** — see Findings), Forgot Password/OTP
  (state-machine gated via `RequireState`), route permissions driven entirely by the backend's
  `moduleList` (no hardcoded per-role logic client-side).
- **Dashboard**: live "sites today" board, 30s auto-refresh, cancel-shift/force-clockout/change-staff
  actions, finance widgets.
- **Company Management** (`companyManagement/`): Company → tabs (client info, details, documents,
  invoices, supervisors) → Site List → per-site tabs (chat, edit work, inspection, map, report,
  roles, staff, task, time allocation; a "Supervisor Access" tab is fully dead/commented-out code).
  Notable engineering depth: STOMP-based chat with lazy-loaded images and bounded-concurrency blob
  fetching; a second independent STOMP connection for live GPS map tracking with geofence editing;
  a day-index-based recurring shift model in Time Allocation.
- **Finance** (`financeManagement/`): **genuinely backend-wired** (dashboard, ledger, site
  profitability, invoices, budgets, bank reconciliation, expenses) — confirmed by explicit code
  comments and real `/finance/*` calls. Bank-statement import accepts CSV only
  (`BankReconciliation.tsx`'s `processFile()` rejects anything else with a clean message) — an
  earlier `xlsx` stub was removed in favour of being truthful about what's actually supported,
  rather than left half-implemented. Four sibling components
  (`FinancialGoalsList`/`IncomesList`/`ExpensesList`/`PaymentMethodsList`) are dead/orphaned
  placeholders not wired into any route.
- **eLearning** (`eLearning/`): **entirely mocked, no real backend** — `eLearningMockApi.ts` is an
  in-memory array store with artificial network delay, wrapped in real-looking React Query hooks.
  Matches the backend finding of no e-learning module at all. Five of its components
  (`AssignmentsList`/`CertificatesList`/`EnrollmentsList`/`ReviewsList`/`StudentProgress`) are fully
  built but unreachable from any route.
- **Incident Management** (`incidentManagement/`): multi-step wizard (Details → [Injured Person] →
  Reporter → Documents → About), step IDs threaded through `localStorage` rather than props, final
  assembly + submit in `ReportSummary.tsx`. Contains a real bug (see Findings).
- **Staff/HR**: `UsersManagement`/`AddEditUser` (multi-tab onboarding: personal, other details,
  sites, bank, emergency, documents, +salary for supervisors — each tab an independent GET+PUT with
  no shared state), `StaffList` (self-registration approval queue, not a staff directory),
  `StaffPayroll`, `TimeSheet` (the most complex page — multi-punch editor, custom quarter-hour
  rounding, bulk approve/deny/edit), `StaffLeaveRequest`/`SupervisorLeave`/`SupervisorSalary`.
- **ToDoList**: 100% `localStorage`-backed, not synced to any backend, not scoped per-user/tenant.
- **DocumentCreator**: fully client-side SOP/SWMS generator from a hardcoded keyword-matched
  knowledge base — no AI/LLM, no backend generation logic (only save/list/delete hit the API).
- **Documents/Drive**: Google-Drive-style file manager with role-based folder sharing.

---

## 5. Findings — ranked by impact

### 5.1 Security (highest priority)

1. **Hardcoded Gmail credential in source** —
   `tenant/config/rabbitmq/TenantMailConfig.java` defines a fallback `JavaMailSenderImpl` bean with
   a plaintext Gmail address and app password committed to git. Rotate the credential and remove it
   from history regardless of whether it's "just a dev default."
2. **Broken AES-GCM encryption** — `common/utils/AesEncryptionDeCryption.java` uses a fixed
   **all-zero, never-randomized nonce/IV** for every encryption. This is used to encrypt tenant SMTP
   passwords at rest and breaks AES-GCM's core security guarantee (nonce reuse enables forgery/plaintext
   recovery in principle). Needs a random IV persisted alongside the ciphertext.
3. **No method-level authorization anywhere** — every restriction is a hand-written
   `if (isClient()) return unauthorizedResponse();` duplicated near-identically across ~15
   controllers; no `@PreAuthorize`/`@Secured`. Confirmed **completely unguarded** sensitive
   endpoints: `SupervisorSalaryController` (set/increment/decrement any supervisor's pay),
   `LeaveRequestController` and `SupervisorLeaveController` (admin-create/approve/reject open to
   any authenticated user), `SiteInspectionController` (approve/reject), `TimeChangeRequestController`
   (approve/deny), `SupervisorController` (company/site access grants), `InvoiceImportController`
   (bulk invoice import), and `TenantUserController.toggleStatus` (can (de)activate any user — its
   sibling endpoints do block CLIENT, this one doesn't).
4. **Likely login-breaking auth bug** — `SuperAdminUser.password` is stored with a manually
   prepended `"{bcrypt}"` prefix, but the wired `PasswordEncoder` is a plain `BCryptPasswordEncoder`,
   not Spring's `DelegatingPasswordEncoder`. Worth verifying at runtime whether the literal prefix
   ends up inside the string compared by `DaoAuthenticationProvider.matches()`.
5. **Likely broken admin queries** — `AdminUserMapper.getAllUsers()`/`findById()` filter on
   `user_type_enum = 'STADD'` / `'STAFF'` respectively — neither matches `INTERNAL`, the type
   actually assigned to admin users. `getActiveRole()` queries `FROM roles` instead of
   `super_admin_roles`. All three read like copy-pasted tenant-side SQL never adapted; `/admin/users/get`,
   `/get-by-id`, `/get-active-roles` are suspect.
6. **WebSocket tenant-trust inconsistency** — `TenantChannelInterceptor` accepts a client-supplied
   `x-tenant-id` and would feed it into raw `SET search_path` SQL if `useSetSearchPath` were ever
   flipped to `true` (currently `false`, so inert, but a landmine). Compare with `ChatController`'s
   `@MessageMapping` handler, which properly resolves the header through `TenantDomainRepository`
   first.
7. **Unsanitized upload filename** — `ChatMessageController.uploadChatImage` writes
   `System.currentTimeMillis()+"_"+originalFilename` to disk without sanitizing `originalFilename`
   (path traversal risk), unlike `ImageStampUtil`, which does sanitize.
8. **Response DTO carries a `password` field** — `tenant.dto.user.TenantUserResponsePojo` includes
   `password`. Even if never populated, this is worth removing from the contract.
9. **Path-traversal guard is decorative** — `FileServiceImpl.deleteFile` logs a warning when a
   target escapes the base directory but still proceeds to delete.
10. **Multi-tenant identification is origin-string-based on the frontend** — the tenant Axios client
    sends `x-tenant-id: window.location.origin` (not a real ID); this is the entire client-side
    tenancy mechanism and depends entirely on backend hostname matching being correct/exclusive.

### 5.2 Correctness bugs likely affecting real users

1. **Incident wizard corrupts data for injury-type reports** — `Incident.tsx` step 4's
   `IncidentDocuments` success handler calls `setIncidentId(id)` instead of `setDocumentId(id)`,
   overwriting the real incident ID with the newly-created document's ID and leaving `documentId`
   empty. Only the injury flow is affected; the near-miss flow's equivalent line is correct.
2. **`CompanyServiceImpl.saveSupervisorSite` / `deleteSupervisorSite` are behaviorally swapped**
   relative to their names — `save...` deletes an exclusion, `delete...` creates one.
3. **`LeaveRequestServiceImpl.currentUserId()` always returns `null`** (explicit TODO in code) — no
   audit trail (`requestedBy`/`approvedBy`) is ever populated for staff leave requests, unlike every
   sibling approval flow in the codebase.
4. **`IncidentManagementServiceImpl.upload()` computes a tenant/date/incident-scoped directory but
   never uses it** — files are actually written flat into `uploadDir/fileName`, without tenant
   isolation, unlike every other upload path in the codebase.
5. **`IncidentManagementController`'s submit endpoint is missing a leading slash**
   (`@PutMapping("submit/{id}")`), producing the concatenated path
   `/tenant/incident-managementsubmit/{id}` — worth confirming against actual frontend usage.
6. **`TenantRolesRepository.findByCode` returns the wrong entity type**
   (`Optional<SuperAdminRoles>` instead of `Optional<TenantRoles>`) — looks like copy-paste.
7. **`TenantUserRepository.findAllSupervisorsAndAdmin`** — missing parentheses around OR/AND in
   native SQL means `is_active` likely doesn't filter the INTERNAL branch as intended (deactivated
   internal users may still be returned).
8. **`LeaveRequestMapper.findAllFiltered`/`findHeaderById`** — three SQL columns all aliased
   `staffName` in the same SELECT; MyBatis will likely only keep the last one, silently dropping
   `requestedBy`/`approvedBy` names.
9. **`AddEditUser.tsx` (superadmin) password-cleanup bug** — `delete (formattedData as any).Password`
   (capital P) targets the wrong key (`password` is lowercase), so the "don't send empty password on
   update" cleanup is a no-op.
10. **`RolePermission.tsx`'s "Select All" toggle never gets its checked-state color** — the class
    string uses `${COLORS.primary}` inside a plain (non-template) string literal, and `COLORS` isn't
    even imported. Same bug exists in both the superadmin and tenant copies of this component.
11. **`AdminProfile.tsx`'s tax-type label never updates** — `onChange` is attached to individual
    `<option>` elements instead of the parent `<select>`; native `<option>`s don't fire `onChange`.
12. **`StaffList.tsx` likely infinite refetch loop** — `useEffect(() => { refetch(); }, [data, refetch])`
    refetches every time `data` changes, and `refetch()` produces new `data`.
13. **`PersonalInfoForm.tsx` raw hardcoded `fetch()`** for new-supervisor company assignment,
    bypassing the tenant Axios client, the `x-tenant-id` header, and the 401-refresh interceptor,
    referencing an apparently-unused `VITE_API_URL` env var with a `localhost:9898` fallback —
    looks like leftover local-dev code.
14. **`AddEditTenants.tsx` (superadmin) builds a malformed auto-suffixed domain** —
    `ipAddress` is set to the raw `VITE_API_BASE_URL` string (e.g. `http://localhost:9898`) rather
    than an extracted host, so auto-suffixed tenant domains look like
    `mysubdomain.http://localhost:9898`.
15. **`apiClients.ts` (tenant) has a stray leading space** inside the `baseURL` template literal.
16. **`StudentProgress.tsx` (eLearning)** reads `mod.lessons`, a field the mock API never populates
    (lessons are fetched separately) — lesson counts/lists always render empty; progress % is a
    hardcoded literal.
17. **Duplicate "Transfer Site" implementations** in `SiteTabs.tsx` and `ViewSite.tsx`, independently
    coded against different endpoint patterns.
18. Several **sensitive values sent as raw query-string parameters** rather than request bodies:
    change-password (both apps), forgot-password/verify-otp/reset-password, user toggle-status.

### 5.3 Data/financial-integrity concerns

- **Money stored as `Double`** in `Invoice`/`InvoiceLineItem`/`FinanceLedgerEntry`/`BankTransaction`,
  while `StaffPayroll`/`SupervisorSalary`/`SiteRole` correctly use `BigDecimal` — inconsistent
  precision handling for currency within the same domain.
- **GST/tax rate has multiple, inconsistent sources of truth**: `FinanceUtils.GST_RATE` hardcoded
  10%, `FinanceServiceImpl.reconcile` hardcodes `/1.1`, `InvoicePdfServiceImpl` correctly reads the
  tenant's configured `taxAmount`, and `ExpenseServiceImpl` never computes GST at all. A tenant with
  a non-default tax rate would get silently wrong ledger-reconciliation numbers.
- **Invoice status transitions are incomplete on the line-item-edit path** — `updateInvoice` only
  handles two of several possible status transitions after totals change (e.g. a `PARTIALLY_PAID`
  invoice that becomes fully covered by a total reduction is never flipped to `PAID`), while
  `addPayment` uses a more complete `deriveStatus()` helper. Two different, inconsistent
  status-derivation code paths for what should be one rule.
- **Invoice-number generation logic duplicated** independently in `InvoiceRepository` (regex
  extract-and-increment) and `InvoiceMapper.getTaxForCompany` (separate SQL implementation of the
  same idea) — can drift.
- **Client-side financial math is authoritative until save**: `InvoiceAddEditModal.tsx` computes
  subtotal/tax/total in plain floating-point JS with no currency-safe rounding before submission;
  `StaffPayroll.tsx` computes gross/adjustments/net client-side for preview, reconciled with the
  server only on save.
- **Custom, asymmetric timesheet rounding** (`TimeSheet.tsx`'s `formatRoundedQuarterHour`: ≤10min→:00,
  ≤25→:15, ≤40→:30, ≤55→:45, else→next hour) feeds displayed hours; whether the backend payroll
  calculation applies the same rule is unverified and worth checking explicitly.
- **Day-of-week pay-rate `CASE` SQL duplicated at least 4 times** across `InvoiceMapper` (x3),
  `StaffPayrollCalcMapper`, `TimeSheetExcelMapper` — and none of these handle the public-holiday
  rate that the underlying `SiteRole`/`StaffSite` schema otherwise supports for Mon–Fri/Sat/Sun.

### 5.4 Architectural inconsistencies worth a cleanup pass

- Three coexisting frontend data-fetching conventions (typed `api.ts` hooks, raw
  `tenantApiClient`/`apiClient` calls inline, ad-hoc `fetch()`), inconsistently applied even within
  the same feature area.
- Two independent STOMP WebSocket clients opened per site-view session (chat, map) rather than a
  shared connection/context.
- Widespread `@OneToOne` used where `@ManyToOne` is semantically correct (see §3), each with its own
  repository-level workaround proving the real cardinality.
- "Delete-and-recreate" child-collection updates (`StaffPayrollServiceImpl.save`,
  `LeaveRequestServiceImpl.adminModify`) coexist with more careful ID-preserving merge patterns
  (`TimeShiftServiceImpl.save`, `SiteInspectionServiceImpl.update*`) for the same general problem.
- Exception typing is inconsistent (`AppException` vs. raw `RuntimeException`/`IllegalStateException`)
  across the service layer, which a single `@ControllerAdvice` can't map to consistent HTTP responses.
- Copy-pasted value objects instead of shared `@Embeddable`s: `CompanyAddress`/`SiteAddress`/
  `TenantDetails.addressGenerator()`; `IncidentManagementInjuredPerson`/`...Reporter`.
- DTO layer has near-zero Bean Validation coverage (no `@Email`/`@Pattern`/`@Size` anywhere, even on
  password/email/phone fields) and several Req/Res type mismatches for the "same" field (e.g.
  `TimeShiftReqPojo.staffId` as `Long` vs. `TimeShiftResPojo.staffId` as `Integer`).
- Large blocks of commented-out dead code left in place across both codebases (notably
  `TimeShiftMapper.java`'s ~800 lines of superseded query versions, `PdfMergeServiceImpl`'s old
  compression implementation, multiple frontend pages).
- Two competing tenant signup pages (`SignUpPage.tsx` vs. `Register.tsx`, the latter's Zod schema
  confusingly named `superAdminLoginSchema`) posting to different endpoints; unclear which one the
  router actually serves at `/signup`.
- `eLearning` and four `financeManagement` sub-pages are fully-built but orphaned/mocked features —
  useful to know before investing further design effort there without confirming product intent.

---

## 6. Suggested priority order if acting on this

1. Rotate/remove the hardcoded mail credential; fix the AES-GCM IV reuse.
2. Add real authorization checks to the unguarded sensitive endpoints (supervisor salary, leave
   approvals, inspection approvals, time-change approvals, user status toggle, invoice import).
3. Verify the `{bcrypt}` prefix issue against a real superadmin login attempt, and the `AdminUserMapper`
   `'STADD'`/`roles`-table queries against a real `/admin/users/get` call — both may already be
   silently broken in production.
4. Fix the incident-wizard `setIncidentId`/`setDocumentId` swap (data-corrupting for every
   injury-type incident report submitted).
5. Everything else in §5.2–5.4 in whatever order matches your roadmap — none of it is a
   drop-everything emergency, but each is a concrete, cheap fix once located (that's what this
   document is for).
