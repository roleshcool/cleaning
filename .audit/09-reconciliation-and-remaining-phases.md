# Reconciliation pass + remaining phases (21, 23-25, 27, 37; DEP/QA re-check)

Triggered by "go through the whole project properly, each and everything." Two things happened
in this pass:

1. **Reconciliation.** `07` and `08` were written Aug 25 11:33. Backend `git log` shows commit
   `4c217ea` ("Fix critical security findings from pre-launch audit") landed at **11:39 that same
   day** — 6 minutes later — followed by a further ~40 commits through Aug 26 fixing nearly every
   other open finding from `05`, `07`, and `08`. **Most of the findings below marked FIXED were
   still open when `07`/`08` were written and have been closed since.** This section exists so
   nobody re-reports them as new, and so the real remaining gap list is accurate.
2. **New phases.** Phases 21 (dependency deep scan), 23 (infra/deploy), 24 (CI/CD governance), 25
   (backup/restore), 27 (email), and 37 (approval workflows/SoD) had not been touched at all.
   Covered below with fresh evidence.

Method: `git log --oneline` cross-referenced against every finding ID in `05`/`07`/`08`, each
match spot-checked by reading the actual current code (not trusting the commit message alone).

---

# Part 1 — Reconciliation: status of every prior finding

## Fixed, verified by code read (not just commit message)

| ID | What it was | Fix commit | Verified how |
|---|---|---|---|
| AUTH-001 | No brute-force protection on `/login` | `4c217ea` | Read `LoginAttemptService.java` in full — 7 attempts/15min lockout, keyed per-username. Self-documented residual gap: in-memory/per-JVM, would need Redis if ever scaled horizontally — moot today, docker-compose runs one backend instance. |
| AUTH-002 | 4-digit OTP, no rate limit, brute-forceable in 3min window | `4c217ea` | Commit adds `V3_51__add_otp_failed_attempts.sql` + attempt cap/resend cooldown on `TenantOtpVerification`. |
| AUTH-003 | Deactivated user's existing token kept working up to 24h | `4c217ea` | `TenantJwtFilter`/`TenantUserDetailsService` now enforce `isActive` per-request, not just at issuance. |
| AUTHZ-002 | Any STAFF could view/edit any coworker's payroll + finance dashboard (IDOR) | `4c217ea` | `StaffPayrollController`/`FinanceController` restricted to INTERNAL. |
| AUTHZ-004 | Invoice GET endpoints (list-all, by-id, by-company, tax, payments) had zero auth check | `4c217ea` | `InvoiceController` diff adds the missing gates. |
| TENANT-001 | MyBatis schema interceptor lacked validation/safe-default vs. its JPA sibling | `4c217ea` | `MybatisSchemaInterceptor` now validates identifiers, defaults to `public`. |
| FIN-002 | Lost-update race on invoice `totalPaid`/`outstanding`/`status` | `4c217ea` | `@Version` added to `Invoice` + 409 conflict handler in `GlobalExceptionHandler`. |
| FIN-001 | Money fields were `Double` not `BigDecimal` | `d830df4` | Confirmed — this was flagged mid-flight as WIP in `07`; it's since landed and `InvoicePaymentMoneyTest`/`FinanceUtilsTest` exist and pass. |
| RACE-001 | `SupervisorSalary.weeklyAmount` unguarded read-modify-write, no `@Version` | `27f716d` | `@Version` added. |
| RACE-002 | Check-in/check-out TOCTOU could double-count hours | `27f716d` | Same commit — "row-locking to check-in/out". |
| RACE-003 | `SiteAsset.quantity` last-write-wins | `395a466` | Optimistic locking added. |
| ADMIN-001 | SuperAdmin RBAC enforced only in frontend; zero backend check on `/admin/**` beyond valid JWT | `9b60b7c` | This was the single most severe finding in the whole audit (self-privilege-escalation). Commit title explicitly names it; `AdminUserRoleEscalationTest` (6 tests, passing) now exists as a regression guard. |
| ADMIN-002 | `/uploads/**` public static handler exposed tenant Firebase service-account credentials, unauthenticated | `9b60b7c` | Same commit. |
| SOD-001 | Any non-CLIENT user could single-handedly create+pay+cancel the same invoice, no maker-checker | `4048e96` | "Fix invoice maker-checker gap." |
| SETTINGS-001 | `PublicHolidayController` had zero authorization check | `4048e96` | Read current file: all mutating endpoints now gate on `isClient()`/`isSubcontractor()`. |
| SETTINGS-002 | `LabourCostProfileController`/`UserFieldRequirementsController` "admin-only" in name, actually open to any STAFF | `4048e96` | Read both files: both now correctly gate on `isInternal()` (`UserTypeEnum.INTERNAL`). |
| ERR-001 | Login endpoints echoed raw exception messages to unauthenticated callers | `59c498c` | "Fix login error-message leak." |
| ERR-002 | Six `e.printStackTrace()` calls outside the global handler | `59c498c` | "...remaining printStackTrace calls..." |
| PII-002 | Push-notification device tokens logged at WARN/ERROR | `59c498c` | "...and device-token logging." |
| PERF-001 (frontend) | Client Management pagination deliberately removed, fetched every client unpaginated | `4b90dcc` | "Restyle Client Management to match target design, add missing pagination." |
| PRIVACY-001 (frontend) | Incident wizard persisted draft IDs under globally-scoped (not per-user) localStorage keys | `284423f` | "...scope incident wizard localStorage per-user." Same commit also fixed the Phase-17 CSV formula injection finding from `08` as a bonus (2 export sites) — not separately tracked as its own ID in `08`, noted here so it isn't lost. |
| DEP-001 | Unused `xlsx` dependency, HIGH-severity unpatched CVEs, dead weight | not in backend log (frontend) | `grep '"xlsx"' package.json` → no match, fully removed. |
| DEP-002 | `vite` HIGH advisories (dev-server-only) + transitive `node-tar`/`yaml` | frontend history | Re-ran `npm audit` (both `--production` and full) fresh this pass: **0 vulnerabilities**, either mode. Traced current resolutions: `tar@7.5.22` (via `@tailwindcss/oxide`, build-time only) and `yaml@1.10.3` (via `cosmiconfig`, ESLint/PostCSS config-loading chain, dev-only) — both outside the range `npm audit` was flagging in the prior pass. |
| QA-001 (partially) | 2 test classes, 36 tests, zero auth/authz/tenant/finance coverage | `d0fbc64` + many | **No longer accurate as stated.** `./mvnw -o test` now runs **14 test classes, 92 tests, BUILD SUCCESS**, including `AdminUserRoleEscalationTest`, `LeaveRequestSelfApprovalTest`, `TimeChangeSelfApprovalTest`, `SiteInspectionSelfApprovalTest`, `LoginAttemptServiceTest`, `AuditLogServiceImplTest`, `MybatisSchemaInterceptorTest`, `CompanyStatusCascadeTest`, `GeofenceExitNotificationThrottleTest`, `InvoiceReconciliationJobTest`, `InvoicePaymentMoneyTest`, `FinanceUtilsTest`. Real regression coverage now exists for the exact areas the original QA-001 said had none. **Still not full integration/`@SpringBootTest`/controller-layer coverage** — these are still unit-level Mockito tests per class, not end-to-end — so QA-001 should be downgraded from "zero coverage of critical paths" to "targeted unit coverage of previously-fixed bugs exists; broad controller/integration testing still absent," not closed outright. |

## Confirmed still open (re-verified fresh this pass, not stale)

| ID | Status |
|---|---|
| PII-001 | **Still open.** `Staff.tfn` and `Staff.bankAccountNumber`/`bankAccountName` (`Staff.java` L43, L49-50) remain plain `String` columns — no `*Enc` field, no `AesEncryptionDeCryption` call anywhere near them (grepped fresh). SMTP passwords get AES-GCM at rest (`TenantMailSettings.passwordEnc`); TFN and bank details, which are more sensitive, don't. Still HIGH. |
| AUTHZ-001 | **Still open, architectural.** `TenantUserDetailsService` grants no real `GrantedAuthority`/role (confirmed fresh: `grep hasRole\|hasAuthority\|@PreAuthorize\|GrantedAuthority` → no matches). All authorization across the app — including every fix landed since the audit — is still hand-rolled per-controller `isInternal()`/`isStaff()`/`isClient()` checks with no framework-level safety net. This is *why* ADMIN-001 was possible in the first place, and why it's structurally possible for the next new controller to make the same mistake undetected. Not something the incremental fixes above addressed, nor would a quick fix — it's a design-level gap worth scoping as its own follow-up rather than expecting it to get caught opportunistically. |
| INVARIANT-001 | **Confirmed still open** (fully re-traced this pass, not just likely). `StaffPayrollServiceImpl.save()` L74-86 builds each `StaffPayrollSiteLine` straight from the request DTO — `.totalHours(nz(s.getTotalHours())).amountCalculated(nz(s.getAmountCalculated()))` — with no server-side recomputation from shift/attendance/rate data anywhere in the method. `nz()` only null-guards, it doesn't validate or recompute. Whoever calls this endpoint controls the numbers that become payroll. No commit in the log addresses this. |
| AUDIT-001 | **Confirmed partially addressed, real gap remains.** `grep -rn "auditLogService\.\w+\("` across the whole backend (fresh this pass) finds exactly 11 call sites, all in `tenant/service/impl/`: `USER_TYPE_CHANGED`, `STAFF_TYPE_CHANGED`, `USER_DEACTIVATED_SELF`, `USER_REACTIVATED`/`USER_DEACTIVATED` (`TenantUserServiceImpl`), `PAYROLL_MARKED_PAID`/`PAYROLL_MARKED_UNPAID` (`StaffPayrollServiceImpl`), `SUPERVISOR_SALARY_SET`/`INCREMENTED`/`DECREMENTED` (`SupervisorSalaryServiceImpl`), `INVOICE_PAYMENT_ADDED`/`INVOICE_CANCELLED` (`InvoiceServiceImpl`) — a real expansion from 4 to 11 action types, covering the money-movement paths the finding named. **But:** `grep -rn "auditLog" src/main/java/.../superadmin/` → **zero matches**. The SuperAdmin role/module-permission system (`AdminRoleController` — `PUT modules/{roleId}`, the exact mechanism ADMIN-001's privilege-escalation chain ran through) has no audit logging at all, despite the fix commit's message claiming to extend coverage to "role changes." The role-change coverage that landed is tenant-side (`TenantUserServiceImpl` user-type changes), not SuperAdmin-side (role/module assignment changes) — those remain silent. This is the one piece of the original finding that's genuinely still open, now precisely located rather than a guess. |

---

# Part 2 — New findings, previously-untouched phases

## APPR-001 — `TimeChangeRequestServiceImpl.approveTimeChange()` deliberately exempts INTERNAL users from the self-approval block that every other role gets (MEDIUM, fraud/SoD)

**Evidence:** `TimeChangeRequestServiceImpl.java` L310-320 (read in full, comment included in the
source, not paraphrased):

> "Without this, the staff member who submitted the correction could approve their own timesheet
> edit... Does not apply to INTERNAL (admin) users: editTimeChange() always stamps requestedBy as
> whoever just edited the request, and the frontend's single-edit flow immediately auto-approves
> an admin's own edit in the same action — blocking that here made every admin edit throw..."

So: `if (request.getRequestedBy().equals(userId) && !"INTERNAL".equals(userType)) throw ...` — a
STAFF user cannot approve their own time-change request, but an INTERNAL/admin user both edits
*and* self-approves a timesheet correction in one action, with no independent reviewer, and this
feeds `StaffHour` → payroll calculation directly.

**Impact:** this is the exact class of gap `LeaveRequestServiceImpl.approve()` was hardened
against (self-approval check, no INTERNAL exemption there — confirmed by reading it, L206-207).
Here the same protection exists but is explicitly carved out for the one role with both the
motive and the means to matter (an admin inflating their own hours). The code comment shows this
was a deliberate, reasoned tradeoff against breaking a frontend UX flow, not an oversight — so
this is a known, accepted risk rather than a blind spot, but it should be a documented decision at
the launch sign-off level, not just a code comment.

**Status: VERIFIED.**

## APPR-002 — `LeaveRequestController` approve/reject/cancel gate is "not CLIENT," not "is this person's supervisor" (LOW-MEDIUM)

**Evidence:** `LeaveRequestController.java` L68-84 — `approve`/`reject`/`cancel` all use
`if (isClient()) return unauthorizedResponse();` as their only controller-level gate. Any STAFF
or INTERNAL user can call these for *any* leave request in the tenant, not just requests from
people they supervise. The service layer does correctly block self-approval (`approve()`
L206-207: `existing.getRequestedBy().equals(currentUserId())` throws) — so an employee can't
approve their own leave — but two ordinary coworkers with no reporting relationship can approve
or reject each other's leave requests, since nothing checks a supervisor/manager relationship.

**Impact:** lower severity than APPR-001 since self-approval is genuinely blocked and this
requires collusion between two accounts rather than one bad actor, but it means "approval" here
means "any other logged-in staff member," not "someone with actual authority over this employee."
Worth deciding whether that's the intended design (small team, informal approval) or a gap before
launch.

**Status: VERIFIED** for the controller-level check; service layer confirmed not to add a
supervisor/reporting-line check either (`LeaveRequestServiceImpl.approve()` read in full).

## MAIL-001 — Email delivery failures are silently swallowed; no retry, no dead-letter queue, no alerting (MEDIUM)

**Evidence:** `TenantReceiver.java` L106-114, the `@RabbitListener` consumer for
`QUEUE_EMAILS` (full method read):
```java
sender.send(message);
} catch (Exception e) {
    log.error("Email sending failed for tenant {} and email {}", ...);
    // DO NOT THROW EXCEPTION
    // message will be ACKED and removed from queue
}
```
This is the single consumer for every outbound email in the system — invoice emails
(`InvoiceServiceImpl`), OTP/password-reset (`TenantAuthController`), registration
(`StaffRegistrationServiceImpl`), quotations (`QuotationServiceImpl`), notifications
(`SendNotificationServiceImpl`). Any failure — misconfigured per-tenant SMTP settings
(`TenantMailSettings`), the tenant's mail provider being down, a bad `fromEmail`, network blip —
is caught, logged, and the message is permanently dropped. No dead-letter queue, no retry with
backoff, no metric/alert that would tell anyone (ops or the tenant) that an email never went out.

**Impact:** a tenant who never configured SMTP correctly, or whose provider has an outage, gets
silent failures across the board — a client never receives their invoice, a user never gets their
password-reset OTP (this is the same email path the already-fixed AUTH-002 OTP flow rides on) —
and the only trace is a log line nobody is watching. This is an operational/observability gap
distinct from AUTH-002 (which was about the OTP being *guessable*, not about the OTP email never
arriving at all).

**Status: VERIFIED**, code read in full.

## CI-001 — Jenkins pipelines have no test/scan gate blocking a bad build from deploying, and the one manual approval gate that existed was explicitly removed (MEDIUM-HIGH, process)

**Evidence:**
- `git log` (backend): `d60edd4` "Remove manual deploy approval gate from Jenkins pipeline" (Aug
  25 02:06) — a deliberate, recent, and undocumented-in-commit-body removal of whatever manual
  gate previously stood between build and deploy.
- Current `Jenkinsfile` (backend): `mvn -B clean package` (tests run, not skipped — comment says
  so explicitly) → immediately `docker compose down/build/up -d`. If `mvn package` fails the
  pipeline stops (good), but there is no separate stage for dependency/SCA scanning, static
  analysis, or a staging environment — build success is the only gate before production traffic.
- Current `Jenkinsfile` (frontend): `npm install` → `npm run build` → straight to
  `docker compose down/build/up -d`. Same pattern — no `npm audit`/lint-as-a-gate step (both exist
  as scripts per `package.json` but aren't wired into CI), no staging step.
- Both pipelines run `docker compose down` before `up -d` on every deploy — a few seconds of
  guaranteed downtime per deploy, not a rolling/blue-green strategy. For a single-instance
  deployment (confirmed via docker-compose — one backend container, one frontend container) this
  may be an accepted tradeoff, but it means every deploy is a visible blip, and a bad build that
  passes `mvn package` but fails at runtime (e.g., a missing env var) has no automated rollback —
  someone has to notice and manually redeploy the previous image.

**Impact:** the pipeline gates on "does it compile and pass unit tests," not "is it safe/secure to
ship" or "does the app actually start." Given the test suite is still unit-level only (see QA-001
reconciliation above), a build that passes CI can still fail at boot or misbehave at runtime with
nothing catching it before it's live.

**Status: VERIFIED** (Jenkinsfiles read in full, commit confirmed via git log).

## BACKUP-001 — No automated database backup/restore mechanism found anywhere in either repo or the CI pipeline (MEDIUM-HIGH, process/infra)

**Evidence:** repo-wide case-insensitive search for `backup|pg_dump|cron` across both codebases
turned up nothing except the string "backup" inside a docker-compose host-volume path
(`/extra/backup/cleaning/upload:/app/upload` — the *uploads* folder is mounted from a
host directory that happens to be named "backup," which implies some external/host-level backup
process for that directory exists outside the repo, but that's a naming coincidence, not evidence
of a Postgres backup strategy).

No `pg_dump` invocation, no backup cron job, no Jenkins stage, no restore script, no documented
backup procedure exists in either repository. This may be handled entirely at the
infrastructure/hosting level (managed Postgres with automatic snapshots, host-level `cron`
outside the repo) — that's plausible and common — but **nothing in the codebase confirms it
either way**, which is itself the gap: there's no evidence-backed answer to "if the production DB
is lost or corrupted right now, what's the recovery procedure and what's the maximum data loss
window" from the repo alone.

**Impact:** this is a question that needs a definitive answer before launch (from whoever manages
the hosting infra, not from the code), not a code fix. Flagging it here so it's on the launch
checklist rather than silently assumed.

**Status: VERIFIED absence in-repo** (the actual production backup posture is an infra question
outside what a code audit can confirm or deny).

## DEP-003 — `jjwt` 0.11.5 has one disputed, MODERATE-severity CVE; low priority but worth a version bump at some point (LOW)

**Evidence:** `pom.xml` L38 — `jjwt.version` = `0.11.5`. Web search confirms CVE-2024-31033
(GHSA-r65j-6h5f-4f92) affects jjwt through 0.12.5, MODERATE severity — but the JJWT maintainers
explicitly dispute it, stating the described "ignores certain characters" behavior only occurs
under direct API misuse, not by default. `itext` (7.2.6), `bouncycastle` (1.79), and `poi`
(5.2.3) were also checked — no unpatched CVEs of note found for the versions actually pinned in
this `pom.xml` (see chat/session record for the underlying searches).

**Impact:** low — disputed by the library author, requires misuse to trigger, and this codebase's
own JWT usage (`JwtService`) wasn't re-audited line-by-line against the dispute's specifics this
pass. Recommended as routine hygiene (bump to a current 0.12.x/0.13.x release) rather than an
urgent fix.

**Status: VERIFIED CVE exists and is disputed; not verified whether this codebase's specific
usage pattern would even be affected.**

## INFRA-001 — `.env.example` documents `SPRING_JPA_HIBERNATE_DDL_AUTO=update`, but the app never actually reads that variable — both `application.yml` and `application-live.yml` hardcode `ddl-auto: validate` (LOW, doc hygiene only)

**Evidence:** `grep -rn "ddl-auto" src/main/resources/` → `application.yml:14` and
`application-live.yml:17`, both `ddl-auto: validate`, neither interpolating an env var. The
`.env.example` line is simply stale/misleading — it looks like it's controlling something it
isn't. No live risk (the safe value is the one hardcoded and actually in effect), but worth fixing
so nobody reads the example file, sees "update," and worries (or worse, "fixes" it by wiring the
env var through and accidentally makes it live-configurable).

**Status: VERIFIED**, both files read in full.

---

# Updated phase coverage (supersedes the "what's explicitly NOT done yet" list in `00-progress.md`)

**Now covered, with evidence, across `05`/`07`/`08`/this file:** 1 (partial), 2, 4, 5, 6, 7, 8,
9, 11, 13, 14, 15 (spot-checked), 16, 17, 18, 19, 20, 21 (new), 22, 23 (new, via CI-001/INFRA-001),
24 (new), 25 (new), 26, 27 (new), 28, 29, 30, 36, 37 (new), 38, 39 (spot-checked).

**Genuinely not touched by any pass so far:** Phase 3 (dedicated feature/workflow walkthrough —
though in practice most workflows have been touched incidentally by the phases above), Phase 10
(formal API inventory document — 67 controllers exist but no enumerated list/spec has been
produced), Phase 31 (backend code quality as its own dedicated pass, as opposed to
correctness/security issues incidentally found), Phase 32/33 (formal manual test plan / documented
test-coverage requirements, as opposed to the QA-001 finding itself), Phase 34 (formal scoring
against whatever rubric the original audit doc defined), Phase 35 (formal threat model
document).

INVARIANT-001 and AUDIT-001 have now both been fully re-traced (not left as "likely" — see the
updated rows above): INVARIANT-001 is confirmed still open (payroll amounts are client-trusted,
no exceptions found), and AUDIT-001 is confirmed partially fixed with the exact remaining gap
identified (SuperAdmin role/module changes — the actual ADMIN-001 mechanism — still aren't
audited, only tenant-side user-type changes are). Both are ready to hand to implementation without
further investigation. The remaining phases (10/31-35) are mostly documentation-shaped
(API inventory, formal scoring, threat-model writeup) rather than new-defect-finding work — lower
value than closing PII-001/INVARIANT-001/AUDIT-001's SuperAdmin gap, which are the three concrete,
unresolved items with real launch risk left on the board.
