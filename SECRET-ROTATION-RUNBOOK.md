# Secret rotation runbook

For the credentials exposed in `.env.bak.multisession`, committed to `origin/staging` on
2026-09-05 (commit `eef6592`) and still present in that branch's history.

**You need to run these steps.** They involve creating and storing credentials, which is the one
category of action I don't take.

---

## What was exposed

| Variable | Rotate? | Notes |
|---|---|---|
| `SPRING_DATASOURCE_PASSWORD` | **Yes** | Postgres login |
| `JWT_SECRET` | **Yes** | Signs sessions |
| `SPRING_RABBITMQ_PASSWORD` | **Yes** | Message broker |
| `GOOGLE_PLACES_API_KEY` | **Yes** | Server-side, billable |
| `GOOGLE_MAPS_BROWSER_KEY` | **Yes** | Browser-side, billable |
| `AES_SECRET_KEY` | **NO — see below** | Encrypts staff bank details |

### Why not `AES_SECRET_KEY`

Staff bank details are encrypted with it. Change it without re-encrypting the existing rows and
every decrypt fails — the payroll screens come up empty and the data is effectively lost, because
nothing else can read those columns.

Rotating it properly is a migration: decrypt every affected row with the old key, re-encrypt with
the new one, in a transaction, with a database backup taken first. That is a planned piece of work,
not a config change. Leave it until you're ready to do that.

---

## Before you start

Verified against the current code, so you can rotate with confidence:

- **Nothing is hardcoded.** All six values come from the environment. No code change is needed.
- **No silent fallbacks** for the four sensitive ones — `application.yml` has `${JWT_SECRET}` with no
  default, so a missing or misspelled value fails at boot with a clear error rather than quietly
  running on something else. If the app starts, it picked up the new value.
- **The Google keys do have empty defaults** (`${GOOGLE_PLACES_API_KEY:}`), so the app still boots
  without them — address autocomplete just returns nothing. That's a soft failure, so check the
  address field actually works afterwards rather than assuming a clean boot means success.
- **The browser Maps key is served by the backend at runtime**, not compiled into the frontend
  bundle. Rotating it needs no frontend rebuild and no redeploy of the frontend.

Config lives in `/home/jenkins/build-envs/cleaning.env` on the deploy host (referenced by both
`docker-compose.yml` and the `Jenkinsfile`).

---

## Order matters

For the database and RabbitMQ, the credential exists in **two** places — the service and the env
file. Change one without the other and the app cannot connect. Do both, then restart.

### 1. Database password

```sql
-- On the Postgres host, as a superuser
ALTER USER <the app's db user> WITH PASSWORD '<new password>';
```

Then update `SPRING_DATASOURCE_PASSWORD` in `/home/jenkins/build-envs/cleaning.env` and restart the
backend container.

Take a database backup first — `./scripts/backup-db.sh` is what the Jenkins pipeline uses.

### 2. JWT secret

Update `JWT_SECRET` in the env file and restart.

**This signs everyone out**, staff on the mobile app included. It is the only user-visible effect of
this rotation, so do it when a wave of re-logins is acceptable — not mid-shift, when cleaners are
clocking in.

### 3. RabbitMQ password

Change it in RabbitMQ, update `SPRING_RABBITMQ_PASSWORD`, restart. Email sending goes through the
broker, so verify a notification actually sends afterwards.

### 4. Google keys

Rotate both in the Google Cloud console, then update `GOOGLE_PLACES_API_KEY` and
`GOOGLE_MAPS_BROWSER_KEY`.

While you're there, **restrict them** — a leaked Maps key gets billed to you, and rotation alone
doesn't prevent the next leak being expensive:

- Browser key → HTTP referrer restriction, limited to your domains
- Server key → IP restriction, limited to the server
- Both → restrict to only the APIs actually in use (Places, Maps JavaScript)

Also worth checking the billing history for the exposure window (2026-09-05 onward) in case the key
was used.

---

## Afterwards

1. Backend boots — if a sensitive value were wrong it would fail loudly, so a clean start is a real
   signal for those four.
2. Sign in. Confirms the database password and the new JWT secret together.
3. Type in a site's Address Line 1 and check suggestions appear. This is the one that fails
   *quietly* if the Places key is wrong.
4. Open a site's Maps tab. Confirms the browser key.
5. Trigger something that emails. Confirms RabbitMQ.

---

## The git history

Rotation is the part that matters — the values stop being useful the moment they change.

The file is gone from the tip of `origin/staging` but remains reachable in history via `eef6592`.
Removing it from history needs a force-push, which rewrites a shared branch and was declined
earlier in favour of the merge. That is still available if you want it later, but it is cosmetic
once the credentials are rotated: anyone who cloned during the exposure window already has the old
values, and no amount of history rewriting reaches them.
