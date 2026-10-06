# Audit Progress

Scope: cleaning_frontend + multitenant_cleaning_backend ("the web application").
primos_enterprise_cleaning (mobile) explicitly excluded unless the user asks otherwise.

Status: IN PROGRESS. Everything below is real, evidence-backed work, not a placeholder.

**READ THIS FIRST — `.audit/09-reconciliation-and-remaining-phases.md`.** Almost every
CRITICAL/HIGH finding recorded below and in `05-findings.md`/`07-.../08-...` was fixed in the
~36 hours after it was written (see `09` for the full commit-by-commit reconciliation). The
finding tables further down in this file are the *original* record and are kept as-is for
history, but they are **stale as a picture of current risk** — do not action anything from this
file or from `05`/`07`/`08` without first checking `09`'s status table. Currently-open items per
`09` (all fully re-verified, not guesses): PII-001 (TFN/bank details plaintext), AUTHZ-001 (no
framework-level RBAC, architectural), INVARIANT-001 (payroll amounts are client-trusted, no
server recomputation), AUDIT-001 (partially fixed — SuperAdmin role/module changes, the actual
ADMIN-001 mechanism, still aren't audited), plus new Phase 21/24/25/27/37 findings (APPR-001,
APPR-002, MAIL-001, CI-001, BACKUP-001, DEP-003, INFRA-001) that were never covered before `09`. DEP-001/DEP-002 are fully resolved
(`npm audit` = 0 vulnerabilities as of this pass). QA-001 needs its severity re-read too — test
suite grew from 2 classes/36 tests to 14 classes/92 tests, including targeted regression tests
for most of the fixed findings; still unit-level only, no integration/controller tests yet.

## Phase 1 — Architecture Discovery (PARTIAL)

### Backend (multitenant_cleaning_backend)
- Spring Boot 3.4.11, Java 17.
- spring-boot-starter-web, -data-jpa, -security, -validation, -webflux, -websocket, -thymeleaf.
- DB: PostgreSQL (runtime driver). Migrations: Flyway (flyway-core + flyway-database-postgresql).
- Query layer: JPA/Hibernate + MyBatis (mybatis-spring-boot-starter 3.0.3) for raw-SQL
  reporting/aggregation queries (34 *Mapper.java files).
- Auth: JWT via jjwt 0.11.5 (jjwt-api/impl/jackson).
- Multi-tenancy: schema-per-tenant via TenantContext + MybatisSchemaInterceptor (established
  from extensive work this session, not re-verified fresh this pass).
- Structure: 67 *Controller.java, 113 entity classes, 34 MyBatis mapper interfaces,
  95 Flyway migration files (V*__*.sql).
- Tests: **2 test classes, 36 total test methods** (CrmLeadFlowTest, QuotationCalculationServiceTest).
  Both are pure Mockito unit tests with no Spring context and no database. Zero integration
  tests, zero controller/security tests, zero tests for auth, authorization, tenant isolation,
  or financial/payment integrity. -> QA-001 (see findings below).
- CI: Jenkinsfile present (Jenkins pipeline, `agent any`, Maven M3 tool). Not yet inspected in
  detail (stages, secrets handling, deploy gating) — pending CI/CD phase (24).

### Frontend (cleaning_frontend)
- React 19.1.0, TypeScript 5.8.3, Vite 7.0.4, react-router-dom 7.7.0.
- @tanstack/react-query 5.89.0, axios 1.11.0.
- Node v24.18.0 (local dev environment).
- tsconfig is a "solution" file — real type-checking MUST use
  `npx tsc --noEmit -p tsconfig.app.json`, not `tsc --noEmit -p .` (established earlier this
  session; the latter silently checks nothing).

## Phase 2 — Build/Test/Dependency Validation (PARTIAL)

| Command | Result | Notes |
|---|---|---|
| `./mvnw test` (backend) | BUILD SUCCESS | 36/36 tests pass, 0 failures, 0 errors. Coverage is narrow (see QA-001). |
| `./mvnw clean test` (backend, offline) | FAILED (tooling) | Local Maven offline cache issue with maven-clean-plugin 3.4.1 (`org.codehaus.plexus.util.Os` missing). Not a code defect — a local `.m2` cache problem. Re-ran without `-o`/`clean` and it worked. Worth a clean `.m2` on CI runners if they hit the same. |
| `npm audit --production` (frontend) | 16 vulnerabilities: 1 critical, 12 high, 2 moderate, 1 low | See DEP-001, DEP-002 below. |
| `npx tsc --noEmit -p tsconfig.app.json` (frontend) | Not re-run fresh this pass | Was clean as of the last check earlier this session (after Dashboard.tsx unused-import fix). Needs a fresh run to be re-marked VERIFIED for this audit specifically. |

## Findings so far (evidence-backed)

### QA-001 — Severe test coverage gap (backend) — Testing/QA phase
**Severity: HIGH** (scoring impact, not an exploitable vuln by itself)
Evidence: `find src/test -iname "*.java"` → 2 files. `find src/main/java -iname "*Controller.java"`
→ 67 files. Zero `@SpringBootTest`/`@WebMvcTest`/integration tests found. No test touches
authentication, authorization, tenant isolation, invoice/payment/refund logic, or any
controller directly.
Impact: Per the audit's own scoring model, Testing/QA is worth 5/100 and Testing confidence
is a full separate /100 score — this area cannot score above a low/failing mark on current
evidence. It also means every other phase's findings in this codebase are LESS trustworthy by
default, since there's no regression safety net catching behavior changes.
Status: VERIFIED (the absence itself, via `find`, is directly verifiable — not an inference).

### DEP-001 — Unused dependency with HIGH-severity, unpatched vulnerabilities (frontend)
**Severity: HIGH** (low effort to fix, zero functional risk)
Evidence:
- `npm audit --production` output: `xlsx *` — Prototype Pollution (GHSA-4r6h-8v6p-xvw6) and
  ReDoS (GHSA-5pgg-2g8v-p4x9), both HIGH, "No fix available."
- `grep -rn "from ['\"]xlsx['\"]" src/` → no matches. `xlsx` is not imported anywhere in
  application source.
- `package.json:49` — `"xlsx": "^0.18.5"` is a direct (not transitive) dependency.
Impact: currently near-zero runtime risk since nothing imports it (dead weight, not an active
attack surface) — but it ships in the installed dependency tree and would become exploitable
the moment anyone imports it for a future feature (e.g. Excel export), and it inflates the
audit's vulnerability count/noise either way.
Recommended fix: remove `xlsx` from `package.json` and re-lock. Zero functional risk since it's
unused. Trivial P1 candidate.
Status: VERIFIED.

### DEP-002 — Frontend dependency vulnerabilities, remainder (frontend)
**Severity: mixed** — needs triage, not yet fully classified
Evidence: `npm audit --production` full output captured in `.audit/06-command-results.md`
(pending — not yet written).
- `vite` 7.0.0–7.3.3: 3 HIGH advisories, all dev-server-only attack surface (arbitrary file
  read via WS, fs.deny bypass) — dev-time risk, not production runtime risk, but still needs
  a version bump since dev machines/CI could be exposed if the dev server is ever reachable
  off-loopback.
  Note: this project is currently pinned to `vite: ^7.0.4` in package.json (established
  earlier this session) — bumping within the same major (^7.0.4 -> a patched 7.x) should be
  low-risk; fix available via `npm audit fix`.
- `node-tar`: 6 advisories (DoS/smuggling family), transitive — need to trace which top-level
  package pulls it in before judging reachability.
- `yaml` 1.0.0–1.10.2: 1 moderate (stack overflow via nested collections), transitive via
  `cosmiconfig` (almost certainly a devDependency chain — ESLint/PostCSS config loading, not
  reachable from the shipped app).
Status: UNVERIFIED in detail — direct/transitive classification and reachability not yet
fully traced for `node-tar`/`yaml`. `xlsx` and `vite` are the two that matter; the rest look
low-reachability but that conclusion isn't proven yet.

## Phases 4-7 — done, see .audit/05-findings.md for full evidence (summary here)

Per user's explicit "prioritize by risk" choice, went deep on the four highest-weighted phases
(Auth 10 + Authz 15 + Tenant 10 + Finance 15 = 50/100 points) before anything else. Headline
findings, all VERIFIED with file/line evidence in 05-findings.md:

- AUTH-001 (CRITICAL): no brute-force protection on /login.
- AUTH-002 (CRITICAL): password-reset OTP is 4 digits, no rate limit -> brute-forceable account
  takeover within its 3-minute window.
- AUTH-003 (HIGH): deactivating a user doesn't revoke their existing access token (up to 24h
  window) — DB is queried fresh every request but isActive is never checked there.
- AUTHZ-001 (HIGH, architectural): Spring Security roles are inert (everyone gets one identical
  authority) — all real authz is ad hoc per-controller with no framework safety net.
- AUTHZ-002 (CRITICAL): Finance dashboard + Staff Payroll (view AND edit, IDOR via staffId) open
  to any STAFF user, no ownership check anywhere in the service layer.
- AUTHZ-004 (CRITICAL, most severe finding so far): several Invoice GET endpoints (including
  "list all invoices") have literally no authorization check — any authenticated user, including
  external CLIENT-role accounts, can read every other company's invoices in the tenant.
- TENANT-001 (MEDIUM, latent): MyBatis's schema-switching interceptor lacks the validation/safe-
  default/reset-on-release hygiene its Hibernate/JPA sibling has — no live exploit path found,
  but it's a real inconsistency worth hardening.
- FIN-001 (HIGH): all monetary fields are `Double`, not `BigDecimal` — will drift at scale.
- FIN-002 (MEDIUM-HIGH): no optimistic/row locking anywhere in the entity model; invoice payment
  aggregate fields (totalPaid/outstanding/status) have a lost-update race under concurrent
  payments (individual payment/ledger rows are safe; the aggregate isn't).

Also confirmed GOOD (don't lose this in the final report): BCrypt hashing, tenant-mismatch check
in TenantJwtFilter, isActive correctly enforced at all token-issuance points, TenantUserController
service-layer checks despite a shallow controller gate, TenantConnectionProvider's proper
schema validation + release hygiene for the JPA path.

User was asked how to handle AUTHZ-004 specifically (it's live/externally reachable via any
client login) mid-audit and chose to keep auditing and address everything together later rather
than an immediate out-of-band fix — respect that choice; do not fix anything without a further
explicit go-ahead.

## What's explicitly NOT done yet

**Superseded — see `.audit/09-reconciliation-and-remaining-phases.md` for the current list.**
Phases 4-9, 11, 13-30, 36, 38-39 are now covered (with varying depth) across `05`/`07`/`08`/`09`.
Genuinely untouched as of `09`: Phase 3 (dedicated feature/workflow walkthrough), Phase 10 (a
formal enumerated API inventory document), Phase 31 (backend code quality as its own pass),
Phase 32/33 (a formal manual test plan / documented test-coverage requirements), Phase 34
(formal scoring against the audit doc's rubric), Phase 35 (a formal threat-model document).
`09` recommends re-verifying INVARIANT-001 and AUDIT-001's current exact boundary before
spending more time on those mostly-documentation-shaped remaining phases.

This is a genuinely multi-session engagement. Continuing phase-by-phase; this file will be
updated after each meaningful chunk of work so nothing is lost across context resets, per the
audit document's own recovery instructions.
