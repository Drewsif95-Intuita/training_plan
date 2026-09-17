# Training dashboard — increment 1

This continues the supplied v3 dashboard. Its layout, seven views, charts, plan
prescriptions and metric distinctions are retained. There is no new training
assessment or measurement refresh in this increment.

## Implemented

- Single-athlete password sign-in; server sessions; logout and session expiry.
- Authenticated dashboard, athlete API, journal and export endpoints.
- Persistent check-ins, gym notes, ankle answers and benchmarks in SQLite.
- Revision checks prevent a stale device from replacing or deleting newer notes.
- Separate activities, recovery and immutable plan-version records.
- Authenticated account export plus consistent SQLite backup and restore commands.
- A responsive shell, app manifest and network-only service worker. Private
  responses are marked `no-store`; browser storage holds only the theme.
- v3 source HTML/CSS/JavaScript separated from private athlete data. Benchmark
  values previously embedded in the template now come from private storage.
- Source-boundary check, integration tests, Docker configuration and GitHub CI.

## Deliberately unfinished

This is the first tested increment requested in the handover. The app is deployed
on the existing Railway service with password protection and a 500 MB persistent
volume mounted at `/data` (17 September 2026). The private-data import routes are
disabled (`ENABLE_DATA_IMPORT=false`). Private data is administered outside this
repository. Live API setup remains pending.
No API token is included or requested in a chat message.

The deployed app is at https://training-dashboard-production-5262.up.railway.app.
Login details are delivered privately and are not stored in this repository.
Deployment is currently manual: the Railway GitHub App is not installed for this
repository, so automatic deployment and waiting for GitHub CI are not enabled.
The 18-test suite passed in GitHub CI before deployment; the Docker build
also runs the test suite. Automatic Railway volume backups are unavailable under
the current account limits.

Tredict daily/manual synchronisation and the Running dynamics view are next.
`POST /api/refresh` reports `501 Not connected` and leaves the snapshot untouched;
it does not pretend to perform a refresh. Status distinguishes the import time,
original retrieval time, observation dates and the absence of an app fetch.

The imported plan JSON is canonical for the dashboard and readable text export.
The original ICS is kept byte-for-byte against its immutable plan version so
existing UIDs survive. Generating **revised** ICS from future plan versions is
still pending. Do not modify the plan without supplying a new version and its
matching calendar. Existing Apple Calendar imports do not update automatically.

The Sunday review has no access to this private journal. Original browser-local
notes are not silently migrated; export them from the old dashboard before
discarding it. Snapshot imports preserve any journal rows already on the server.
There is no journal-file import screen yet.

## Validation in this task

- 18 automated integration and rendering checks passed on Node 24.19.0.
- The supplied private v3 snapshot and plan passed a separate import round trip.
- Original ICS bytes and UIDs were unchanged. All seven renderer paths, four
  sport tabs and twelve week selections executed successfully with the supplied
  data in a DOM stub harness. No private records are included in the tests.
- Railway deployment, volume attachment, HTTPS health, session handling and
  unauthenticated access checks passed. The hosted sign-in page was visually
  checked in a browser. Authenticated browser and physical-phone checks remain pending.

## Local setup

Use Node **24.19 or later within 24.x**. The server uses built-in Node modules;
there is no dependency installation step. Passwords use scrypt with random salts.

```bash
npm test
node scripts/check-source.mjs
cp .env.example .env
npm run manage -- password-hash
```

Run the password command in your own terminal. It prompts without echoing the
password. Copy only the resulting hash into `AUTH_PASSWORD_HASH` in `.env`.

Import the private JSON from the existing v3 ZIP. Keep that ZIP, snapshot, plan,
original calendar, exports and screenshots outside the repository directory.

```bash
node --env-file=.env scripts/manage.mjs import-snapshot /absolute/private/path/snapshot.json
node --env-file=.env scripts/manage.mjs import-calendar /absolute/private/path/original-calendar.ics v3
node --env-file=.env src/server.mjs
```

Open `http://127.0.0.1:3000`. The first visit requires the password. Re-importing
the same snapshot is idempotent; it cannot overwrite newer server journal rows.
Different content using an existing plan version is rejected.

The `.gitignore` is a convenience, not a privacy guarantee. Stage only reviewed
source. `scripts/check-source.mjs` rejects unexpected root files and common
private file types; additionally inspect staged changes before pushing.

## Railway deployment gate

Reuse the existing service identified in the private handover. Its initial empty
configuration has now been deployed with the selected repository, authentication
variables, HTTPS domain and persistent volume. The checklist below remains the
reference for validating future changes.
Do not create a replacement project or service.

1. The selected repository is `Drewsif95-Intuita/training_plan`, deployed from `main`.
   The owner has authorised direct commits. The source contains only synthetic test
   records; keep actual data outside Git history.
2. Attach a persistent volume at `/data` to the existing service, keep one replica,
   and enable volume backups within the authorised account limits. A volume
   protects data through restarts; an independent backup protects against loss.
3. Configure `NODE_ENV=production`, `DATA_DIR=/data`,
   `APP_ORIGIN=https://<the-service-domain>` and `AUTH_PASSWORD_HASH` privately in
   Railway. Railway supplies `RAILWAY_VOLUME_MOUNT_PATH`. The app refuses to start
   without HTTPS, a valid hash or a data directory inside the volume.
4. Connect the selected repository/branch. Require the `Verify / test` check;
   enable Railway's option to wait for CI. The Docker build also runs tests.
5. Deploy, then wait for a successful terminal deployment state and verify
   `/healthz`, unauthenticated endpoint denial, sign-in and logout over HTTPS.
6. Transfer/import the private snapshot and original calendar via an authorised
   private administrative path. Never place them into the build or repository.
7. Verify a saved note after restart, export/restore, and physical-phone sign-in,
   sign-out, app installation, offline behaviour and browser-back behaviour.

Physical iPhone/Safari checks remain outstanding; local emulation cannot replace them.
The hosted sign-in page was checked, but authenticated dashboard layout, browser
sign-in/out, back-cache and install/offline behaviour remain unverified. Renderer
smoke checks use DOM stubs and do not test layout.

## Backup and restore

For the first private transfer to a hosted service, temporarily set
`ENABLE_DATA_IMPORT=true`. The authenticated, same-origin, CSRF-protected
`POST /api/import-snapshot` accepts `{ "snapshot": ... }` and
`POST /api/import-calendar` accepts `{ "calendar": "...", "version": "..." }`.
The request limit is 15 MB. Imports use the same validation, immutable versions
and journal-preservation rules as the local management commands. Send data over
HTTPS, never through Git. Set `ENABLE_DATA_IMPORT=false` and redeploy after the
transfer; import endpoints are disabled by default. The single athlete account
is also the administrator. These routes are not a multi-user upload feature.

Railway deployment settings are configured on the existing service. The current
Railway API rejects setting `railwayConfigFile` for the legacy TOML configuration;
the Dockerfile is used directly. Verify live service settings after changes.
The account currently allows no managed volume backups. Export and SQLite backup
commands below remain available; automated off-volume backups are not configured.

```bash
node --env-file=.env scripts/manage.mjs backup /absolute/private/backup-new.sqlite
node --env-file=.env scripts/manage.mjs export /absolute/private/account-new.json
node scripts/manage.mjs restore-sqlite /absolute/private/backup-new.sqlite /absolute/private/new-data-dir
```

Stop the app before restore. Restore requires an empty target, checks SQLite
integrity and revokes copied sessions. Change `DATA_DIR` to the restored directory
and restart. Keep the old directory until the restored app is verified. The JSON
export is readable and includes plan versions, original calendars and journals;
the supported full recovery route in this increment is the SQLite backup.

Backups contain private data. Keep an encrypted copy independently of the live
volume. Scheduled/off-volume backup configuration has not yet been applied.
Rotate `AUTH_PASSWORD_HASH` to revoke all existing sessions on next startup, or
run `revoke-sessions` against the active data directory to revoke immediately.

## Next increment: Tredict and running dynamics

The documented Personal API uses bearer tokens against the OAuth2 API endpoints;
the ChatGPT connection does not provision a token for this server. The intended
read scopes are `activityRead` and `bodyvaluesRead`. A personal token may deactivate
after two weeks without visiting Tredict and reactivate on a web visit.

Verified activity routes:

| Purpose | Official contract |
| --- | --- |
| Activity list | `GET /api/oauth/v2/activityList`, `startDate`, `pageSize` (50–1000), `extendedSummary=1`; follow `_links.next.href` |
| Detailed activity | `GET /api/oauth/v2/activity/{id}?extraValues=1&allSeries=1&withLaps=1` |

Responses can return `401`, `403` or `429`. Validate next-page URLs against the
official host before sending a token. Detailed sampled series are not the same
contract as ChatGPT activity-list tool responses. Verify the health endpoints,
actual field units and current limits before implementing their normalisers.

Preserve measured/missing points and sampling intervals. Keep reported summary
averages separate from sampled-series means; validate grade separately. Use only
comparable session, pace, terrain and sensor contexts. Dynamics are descriptive;
do not create an economy or injury score. Keep the last good data on a failed
refresh and expose coverage and failures per source.

## References

- [Tredict Personal API](https://www.tredict.com/faq/personal-api---connect-your-own-scripts-or-personal-applications/)
- [Tredict official API contract](https://www.tredict.com/blog/oauth_docs/)
- [Node SQLite and backup API](https://nodejs.org/api/sqlite.html)
- [Node cryptography API](https://nodejs.org/docs/latest-v24.x/api/crypto.html)
- [Railway GitHub deployments](https://docs.railway.com/deployments/github-autodeploys)

The source comments, examples and automated fixtures are synthetic. Validation
results for this increment accompany the delivery message; this document does
not turn pending deployment checks into completed ones.
