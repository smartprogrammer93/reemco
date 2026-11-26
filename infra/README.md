# Reemco self-hosted infrastructure (REEA-1044)

Single dedicated server replacing the Vercel deployment. **Ubuntu 26.04 LTS
(Resolute Raccoon), bare metal — not Proxmox.** The decision record, sizing,
risks and phased cutover are in the issue plan document
(`REEA-1044` → Documents → plan), not duplicated here.

Everything in this directory is the deployable truth. If it is not in git, it
does not exist on the host.

## Layout

| Path | Purpose |
|---|---|
| `cloud-init.yaml` | First boot: users, SSH posture, UFW, chrony, fail2ban, unattended upgrades, 26.04 delta checks |
| `ansible/playbook.yml` | Idempotent host convergence: pinned Docker, `/opt/reemco` config, timers, firewall |
| `ansible/inventory.example.yml` | Copy to `inventory.yml`, set `ansible_host` |
| `compose.prod.yml` | app + local Valkey (native RESP KV) + Caddy |
| `Caddyfile` | TLS + HSTS; app owns CSP/CTO/Referrer-Policy (do not duplicate them); strips `Via` (REEA-1085) |
| `Dockerfile` | Production image, tag = commit sha, standalone Next output |
| `scripts/deploy.sh` | Deploy a pinned tag, auto-rollback on failed verify |
| `scripts/rollback.sh` | Redeploy the recorded previous tag, same verify gate |
| `scripts/verify.sh` | Commit stamp + 4 security headers + no `Via` leak + absent `X-Powered-By` + health + container hardening assertions |
| `scripts/assert-compose-hardening.sh` | CI gate: renders the compose file and asserts the hardening invariants |
| `scripts/assert-containers.sh` | Post-deploy `docker inspect` assertions on the running stack (called by `verify.sh`) |
| `scripts/backup.sh` | Restic backup of the durable state (docker volumes + `/opt/reemco` + `/etc/reemco`) |
| `scripts/restore-drill.sh` | Restore latest snapshot to a scratch dir and verify the sample against live volumes |
| `systemd/` | `/api/health` probe timers (the scheduled health cadence) + daily backup |
| `app.env.example` | Runtime **secrets** → `/etc/reemco/app.env` (0640) |
| `release.env.example` | Non-secret site config → `/etc/reemco/release.env` (0640) |
| `backup.env.example` | Backup target config → `/etc/reemco/backup.env` (0640); password file 0600, never committed |

## Provision (once SSH exists)

1. Install Ubuntu 26.04 LTS with `cloud-init.yaml` as user-data. **Before
   wiping disks**, confirm the controller is mdadm and not firmware fake RAID
   (`cat /proc/mdstat` after `mdadm --create`).
2. Run the §3a blocking checks from the plan on the real hardware: `sudo -V`,
   `dpkg -S /usr/bin/cp`, `chronyc tracking`, `sshd -t`, `lspci -k` for NIC/NVMe.
   Any failure → install 24.04 instead; nothing else changes.
3. `cp ansible/inventory.example.yml ansible/inventory.yml` and set the host.
4. `ansible-playbook -i infra/ansible/inventory.yml infra/ansible/playbook.yml --check`
   then without `--check`.
5. Inject secrets into `/etc/reemco/app.env` (never commit them) and set
   `REEMCO_SITE_ADDRESS` in `/etc/reemco/release.env` to the box IP for standup.

## Deploy

`Actions → Deploy self-hosted → Run workflow` with `site_address` = the box IP
or hostname. The workflow builds `reemco/app:<sha>` **on the box** from the pushed
tree, syncs `infra/` to the host, runs `deploy.sh --tag <sha>`, and verifies stamp
+ headers + smoke from outside the box.

Manual equivalent on the host: `sudo /opt/reemco/scripts/deploy.sh --tag <sha>`.

## Rollback

Run the same workflow with `rollback_sha` = the previous known-good commit
(no rebuild — it redeploys the existing artifact). On-host equivalent:
`sudo /opt/reemco/scripts/rollback.sh` (uses `/etc/reemco/image-tag.prev.env`,
written by every deploy). This is the only rollback path since REEA-1076: the
Vercel alias (402 `DEPLOYMENT_DISABLED`) is gone, so if the box itself is
unreachable the recovery path is the host backup/restore drill, not a DNS flip.

**No rollback path, no deploy.**

## Deploy gate — what blocks, what is advisory, who changes it

Owner: **DevOps Engineer**. This section is the single place the gate's split is
written down; a change to it is a reviewed diff to
`.github/workflows/deploy-selfhosted.yml` **plus this section in the same commit**.
Never edit the gate by hand on the box — every deploy overwrites `/opt/reemco`
from git.

**Blocking — a failure fails the deploy and takes the rollback path:**

1. Build gate — `npm run lint` and
   `NODE_ENV=test KV_REST_API_URL= KV_REST_API_TOKEN= npm run test` on the pushed
   tree (REEA-1067). Runs on the GitHub runner **before** any SSH or host build, so
   a red gate never mutates the box; skipped only for an explicit `rollback_sha`
   (redeploys an already-verified artifact, and an emergency rollback must not be
   blocked by a gate that is red on `main`). Pinned by `src/deploy-gate.test.ts`.
2. Production dependency audit gate — `npm audit --omit=dev --audit-level=high` on
   the committed lockfile (skipped only for an explicit `rollback_sha`, which
   redeploys an already-verified commit).
3. Compose hardening invariants — `infra/scripts/assert-compose-hardening.sh`
   (cap_drop ALL / non-root, digest-pinned infra images, segmented networks).
4. On-host build of the pinned commit tag.
5. Deploy of the pinned tag — `deploy.sh` auto-rolls-back if its on-box verify fails.
6. Public-surface verification — served `/__commit.txt` must equal the intended SHA,
   all four security headers (CSP, X-Content-Type-Options, Referrer-Policy, HSTS)
   must be present, and `X-Powered-By` must be absent (REE-1084 F7a: suppressed at
   the source via `poweredByHeader: false`, asserted on the wire by both gates).
   Since REEA-1088 the CSP check is stricter than presence: the served `script-src`
   must carry a per-request nonce plus `'strict-dynamic'` and no `'unsafe-inline'`
   (a bare `'self' 'unsafe-inline'` policy is the pre-F10 regression).
7. Funnel smoke suite (`npm run smoke`: home → results → click-out, freshness, 375px
   mobile pass, offer link-health, adapter-registration parity, cache headers, served
   CSP nonce freshness).
   Restored to blocking in REEA-1059 after the two deterministic failures that had made
   it advisory were fixed: step 5 now proves reachability inside the deliberately
   scrollable coverage row instead of failing on it (REEA-1056), and step 7 no longer
   requires the retired PC Kuwait lane (REEA-901).
   Step 6 (offer link-health) classifies a bot-wall answer — HTTP 429, or a 403 carrying
   a `cf-mitigated` header or a Cloudflare challenge/block body marker ("Just a moment",
   "Attention Required! | Cloudflare", the JS/cookie interstitial) — as
   bot-blocked/reachable, not dead (REEA-1166; the classifier is the REEA-935
   `scripts/dead-link-smoke.mjs` core, pinned in `src/lib/metrics/link-smoke-checker.test.ts`).
   It never rescues a genuine failure: 404/410, a plain 403 without a marker, 5xx after
   retries, and timeouts still fail the gate and roll the deploy back. The timing probe
   that runs before the functional steps is report-only and does not gate.
   Since REEA-1184 every app GET in the suite is throttle-aware
   (`scripts/smoke-http.mjs`): it retries HTTP 429/503 up to 4 attempts, honouring the
   served `Retry-After` (capped at 30s) and falling back to bounded exponential backoff.
   The app gates `/results` and `/product` with a per-IP budget of 60 requests/minute
   (`src/proxy.ts` PAGE_RATE_LIMIT, REEA-1133), and the smoke's 19 timing queries plus the
   headless browser's link prefetches spend that budget from one runner IP. A 429 there is
   the limiter pacing a machine client, not a broken build — before REEA-1184 it failed
   step 7 and rolled back three healthy deploys of `641c2b7` (run `45728235136`). If every
   attempt is still throttled the smoke exits **2** (not 1); the workflow then cools down
   75s and reruns the smoke once before any rollback, and only a real failure (exit 1) or
   a second throttled run rolls the build back. Pinned in
   `src/lib/metrics/smoke-http.test.ts`.
8. Secrets hygiene — `verify.sh` fails when `/etc/reemco/release.env` still carries a
   `REEMCO_KV_TOKEN=` line (dead: no consumer, the KV REST surface was replaced by
   RESP to Valkey) or when any hand-made `/etc/reemco/*.bak-*` env copy remains
   (REEA-1086 F8). Both are host-side checks; the deploy gate runs them on the box.

The build gate is CI-side rather than in `infra/Dockerfile`: the box's CPU is
production capacity, and `.dockerignore` excludes `.github` while
`src/ci-secrets.test.ts` reads `.github/workflows/deploy.yml`, so an in-image suite
would need a widened build context to mean anything. The manual on-box build
fallback therefore bypasses CI — treat it as emergency-only and run the gate
commands by hand first.

**Advisory — runs and alerts, but does not fail the deploy:**

- _Nothing, as of REEA-1059._ Every gate above blocks. This is the intended steady
  state; an advisory exception must be re-added here deliberately, never inherited.

An advisory exception is **not a resting state**: it must carry an open tracking issue
and a named owner who flips it back, and it is recorded in this section in the same
commit that adds it. If a flip-back does not happen, the exception has been forgotten —
treat the gate as wrong, not the check. The one just closed (smoke, advisory under
REEA-1054 while REEA-1056 was open) is the cautionary example: REEA-1056's fix landed
inside another commit and the gate would have stayed advisory by silence.

The workflow only invokes the rollback path when a deploy actually reached the box
(`steps.deploy.outcome == 'success'`), so a CI-only failure (audit gate, hardening
assertion) no longer reverts production for a failure that never touched it.

### True-negative proof (REEA-1194, 2026-11-26)

REEA-1184 proved that throttling no longer rolls healthy builds back; its other
bar — that a genuinely dead link still fails the gate — was argued from the code
path. It is now demonstrated on a run:

- Test commit `dc571d3` changed one `src/lib/catalog.ts` offer URL to
  `https://www.xcite.com/reea1194-deliberately-dead-link/p`; xcite answers that
  slug with HTTP 200 and the title `404: Page Not Found - Xcite Alghanim`.
- Deploy run `45758034793` attempt 2: build gate, audit and hardening assertions
  green; `deploy.sh` deployed `dc571d3`; the public stamp and headers verified;
  then the blocking smoke failed with
  `SMOKE FAILED at step 6 (catalog offer URLs resolve (link-health)): 1/19 offer URL(s) dead: https://www.xcite.com/reea1194-deliberately-dead-link/p (HTTP 200 title="404: Page Not Found - Xcite Alghanim")`
  and exited 1.
- The workflow invoked the on-host rollback: `rollback: dc571d3 -> 76b8da11`,
  `VERIFY PASSED for 76b8da11`, `rollback verified: 76b8da11`. Production was
  back on the previous tag 64 s after the smoke failure (05:07:31Z → 05:08:34Z).
- The dead-link commit was reverted in the next commit, which deployed green.

Incidental true positive from the same window: attempt 1 of that run failed
before the smoke because `assert-containers.sh` refused to pass while a
restore-drill scratch container published `127.0.0.1:3100`. The container
posture assertion works — but it also fails a *rollback* verify, so keep scratch
containers out of deploy windows (see the drill gotcha under Backup and restore).

## Container hardening (REEA-1061)

The stack is capability-minimal and its infrastructure images are immutable:

| Service | Identity | Caps | Rootfs | Limits | Networks |
|---|---|---|---|---|---|
| app | uid 1001 (image user) | `cap_drop: ALL` | writable (volumes + `/tmp`) | 6g / 6 CPU / 512 pids | `edge`, `data` |
| redis | image user `valkey` (uid 999) | `cap_drop: ALL` | read-only, `/data` volume only | 512m / 256 pids | `data` only |
| proxy | uid 1000 | `cap_drop: ALL` + `NET_BIND_SERVICE` | read-only, `/data`+`/config` volumes + `/tmp` tmpfs | 256m / 128 pids | `edge` only |

`edge` is proxy↔app; `data` is app↔redis and is `internal: true` (no gateway).
The proxy cannot resolve `redis`, and Valkey is not reachable from the edge.

Two invariants are enforced automatically, so a regression cannot ship silently:

- CI: `infra/scripts/assert-compose-hardening.sh` renders
  `docker compose -f infra/compose.prod.yml config` and fails the deploy
  workflow before SSH if any invariant is broken. It rewrites the two
  host-absolute paths (`/etc/reemco/app.env`, `/opt/reemco/Caddyfile`) to empty
  local placeholders so it also runs on a GitHub runner.
- Post-deploy/rollback: `verify.sh` calls `infra/scripts/assert-containers.sh`,
  which `docker inspect`s the running containers and fails the gate if redis or
  proxy is root, `CapDrop` lacks `ALL`, the rootfs is writable, the networks are
  not segmented, or the running image digest differs from the pinned digest.

**Volume ownership.** A named volume is created root-owned, and redis/proxy now
run non-root. `deploy.sh` and `rollback.sh` converge ownership before `up`
(`chown -R valkey:valkey /data`, `chown -R 1000:1000 /data /config` for Caddy)
using the same digest-pinned images. It is idempotent; a fresh volume is handled
on the next deploy. Do not create these volumes outside that path.

**Digest bumps.** The caddy and valkey images are pinned to
`caddy@sha256:003a9780…` and `valkey/valkey@sha256:9971099a…`. To bump one:
record the new digest in the deploy comment, update the `image:` line, run
`bash infra/scripts/assert-compose-hardening.sh`, deploy, and confirm
`assert-containers.sh` reports the running digest matches.

**Caddyfile caveat.** The explicit `http://{$REEMCO_SITE_ADDRESS}` block is what
suppresses `Server: Caddy` on the HTTP→HTTPS 308. It is only valid while the
site address is a DNS name; a bare-IP standup address would define the site
twice and Caddy would refuse to start — comment the block out in that case.

**`Via` suppression (REEA-1085).** `reverse_proxy` appends `Via: 1.1 Caddy` to
forwarded responses after `header`/`header_down` run, so the only working
pattern on the pinned Caddy 2.11.9 is a `handle_response { header -Via;
copy_response }` block inside `reverse_proxy` (caddyserver/caddy#7643).
`omit_via_header` does not exist in 2.11.9. `verify.sh` step 2 fails the deploy
if `Via` is served, and the funnel smoke steps 1–8 (incl. `/results` and
`/search`) prove the wrapper did not change streaming/RSC behaviour. Validate a
Caddyfile edit before deploying:
`docker run --rm -e REEMCO_SITE_ADDRESS=<host> -v $PWD/infra/Caddyfile:/etc/caddy/Caddyfile:ro <pinned-caddy-digest> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`.
Rollback: redeploy the previous commit via the workflow `rollback_sha`; the
`handle_response` block simply disappears with that ref.

**Rolling back this change.** Compose/Caddy changes are versioned: redeploy the
previous commit through the deploy workflow with `rollback_sha` (it re-syncs
`/opt/reemco` from that ref, so the old stack shape comes back), then run
`sudo /opt/reemco/scripts/verify.sh --tag <sha>`. The pre-change files were
copied to `/opt/reemco/backup/reea1061-20261122T222355Z/` on the box as a
belt-and-braces restore path.

## Enforced ingress surface (REEA-1087 / F9)

Follow-up to the REEA-1052 security review. Three residuals, each with an
explicit disposition — none is left silent.

**1. SSH source allowlist — deferred with reason.** `ufw` still allows
`22/tcp` from Anywhere (v4 and v6). The admin/office/VPN CIDR was never supplied
by the board, so the recorded decision is to keep 22 world-open and rely on the
compensating controls: key-only SSH (`PasswordAuthentication no`,
`PermitRootLogin no`, `MaxAuthTries 4`) plus the fail2ban sshd jail (maxretry 4,
1h ban). Residual risk: 22 is world-open but unauthenticated clients cannot get
in. Closing it is one versioned knob: set `reemco_ssh_allow_from: "<CIDR>"` in
`infra/ansible/playbook.yml` and run the playbook — it adds
`ufw allow from <CIDR> to any port 22 proto tcp` and deletes the world-open
rule. **Keep the current session open and prove a NEW connection before you
finish; rollback is `sudo ufw allow 22/tcp` from the still-open session.**

**2. DOCKER-USER — closed in code.** Docker publishes ports by DNAT + FORWARD,
which bypasses UFW's INPUT chain entirely; an empty `DOCKER-USER` therefore made
the declared firewall posture a fiction. `infra/scripts/docker-user-firewall.sh`
installs a `REEMCO-DOCKER-INGRESS` chain jumped from `DOCKER-USER` on both
families that allows ESTABLISHED/RELATED, ICMP, tcp 80, tcp 443 and udp 443
(HTTP/3), and drops everything else **arriving on the WAN interface** — the `-i`
scope is deliberate so container egress (the retailer adapters) is untouched.
It is applied by `infra/systemd/reemco-docker-user-firewall.service`, installed
and enabled by the playbook (`WantedBy=multi-user.target`, ordered after
`docker.service`, so a reboot comes up with the rules); `PartOf=docker.service`
re-applies it after a docker restart (Docker recreates the chain, so rules are
not self-persistent).
Rollback: `sudo /opt/reemco/scripts/docker-user-firewall.sh revert` then
`sudo systemctl disable --now reemco-docker-user-firewall.service` — this
restores Docker's default (published ports reachable), so it is fail-open.

The compensating check is in `infra/scripts/assert-containers.sh`, run by
`verify.sh` on every deploy and rollback: the published-port set must be exactly
proxy 80/443 (tcp + udp) on all interfaces and app 3000 on `127.0.0.1`, and
`DOCKER-USER` must carry the jump on v4 and v6. A new `ports:` entry therefore
fails the deploy gate instead of silently widening the attack surface.

**3. docker group — accepted with reason.** `deploy` and `ubuntu` are members of
`docker`, which is root-equivalent on the host: `docker run -v /:/host` is a root
shell. The scoped sudo allow-list (`/etc/sudoers.d/reemco-deploy`, REEA-1054) is
**not** a no-root-shell guarantee — it only narrows the non-Docker surface.
Accepted for the single-tenant box: both accounts are ours, CI runs as `deploy`
and needs Docker to build and deploy. Revisit if the box ever hosts untrusted
workloads or a second tenant — the fix is rootless Docker or sudo-only compose
invocation.

## Backup and restore

The durable state is the docker named volumes (`reemco_metrics`,
`reemco_events`, `reemco_collect`, `reemco_redis`) plus `/opt/reemco` and
`/etc/reemco`. There is **no `/data` on the host** — the compose file mounts
those volumes at `/data/*` *inside* the app container; the host-side paths are
`/var/lib/docker/volumes/<volume>/_data`. `backup.sh` therefore targets the
volume mountpoints, takes a Valkey `BGSAVE` first so the KV snapshot is
self-consistent, and fails fast if any path is missing instead of silently
backing up less than it claims.

`/etc/reemco/backup.env` (0640, host-only) supplies `RESTIC_REPOSITORY` and
`RESTIC_PASSWORD_FILE`; the password file is `0600 root:root` and its value is
escrowed in Paperclip Secrets (`reemco/restic-password`) because losing it means
losing the repository. `reemco-backup.timer` runs nightly at 03:23 UTC.

**Target status: on-box, accepted.** The repository currently lives at
`/var/backups/reemco-restic` on the same RAID1 array. The board accepted this
explicitly on 2026-11-22 ([REEA-1048](/REEA/issues/REEA-1048)), which satisfies
the "explicit no off-box backup yet, accept the risk" branch of that issue. It
protects against bad writes, container/volume removal, accidental deletion and
corruption — **not** against losing the host. Revisit when the dataset grows or
before any provider-side migration; moving to a bucket is a one-line
`RESTIC_REPOSITORY` swap plus `restic init` and one green run, and the drill
re-runs unchanged.

### Inventory, RPO and RTO (REEA-1194 — measured 2026-11-26)

| State | Host path | In the nightly snapshot | RPO |
| --- | --- | --- | --- |
| KV / price-history store (Valkey: `metrics:weekly:v2:*`, `seen:*`, `collect:*`, `pc:*`, `ratelimit`, lane health) | `reemco_redis` volume | yes — `BGSAVE` first, `dump.rdb` captured | ≤ 24 h |
| Weekly metrics store | `reemco_metrics` volume (`metrics.json`) | yes | ≤ 24 h |
| Funnel events | `reemco_events` volume (`events.jsonl`) | yes | ≤ 24 h |
| Collect store (last-seen / job snapshots) | `reemco_collect` volume | yes | ≤ 24 h |
| Server config, compose, Caddyfile, scripts | `/opt/reemco` | yes | ≤ 24 h |
| Env + deploy state (`app.env`, `release.env`, `image-tag*.env`, `backup.env`) | `/etc/reemco` | yes (`restic.pass` excluded; its value is escrowed in Paperclip Secrets) | ≤ 24 h |
| Container images | `/var/lib/docker` | **no** — rebuilt from the git SHA (`infra/Dockerfile`); the rollback tag stays cached on the box | n/a (reproducible) |
| TLS certificate + Caddy state | `reemco_caddy-data`, `reemco_caddy-config` volumes | **no** — re-issued automatically by ACME/Let's Encrypt from `REEMCO_SITE_ADDRESS` | n/a (minutes, no data loss) |
| The restic repository itself | `/var/backups/reemco-restic` (same RAID1) | n/a | **box loss = every snapshot lost** |

Measured restore (drill, 2026-11-26, snapshot `2d4dd7d6` taken 03:26:48Z):
`restic restore` of 538 files / 98.151 MiB into `/var/tmp/reea1194-restore`
completed in **2 seconds**; the full drill (restore + all checks below) took
**1 min 46 s**. End-to-end in-place recovery (restore + `compose up` + verify.sh)
is estimated at **under 10 minutes** — the app start and `verify.sh` are the
long poles, not the restore.

Verified against the restored copy:

- `metrics/metrics.json` and all three `collect/*.json` files byte-identical to
  the live volumes.
- `events/events.jsonl`: 22,720 restored lines, **all present** in the live
  volume (live had 23,157 at drill time — the delta is post-snapshot traffic).
- Restored Valkey keyspace: `DBSIZE` 32,800 (live 34,763 at drill time), and
  `metrics:weekly:v2:*` count **146 = live 146**. Sampled key
  `metrics:weekly:v2:2026-W48:att:Danube Home`: restored `16595`, live `17021`
  (live advanced after the snapshot — the restored value is the snapshot-time
  value, not a copy of live).
- The weekly-metrics endpoint **read the restored store**: a scratch
  `reemco/app` container with `METRICS_DIR`/`EVENTS_DIR`/`COLLECT_CACHE_DIR`
  pointed at the restored directories and `REDIS_URL` pointed at a scratch
  Valkey loaded from the restored `dump.rdb` answered
  `GET /api/metrics/weekly` **HTTP 200** with W47 `searches=1338,
  zero_offer_searches=11` (identical to live) and W48 `searches=17962` vs live
  `18498` (post-snapshot growth).

**Honest RPO answer: 24 hours for data loss/corruption on this box; unlimited
for box loss.** Because the repository is on the same array, losing the host
loses the snapshots too. The cheapest fix (≈ $0 at 193 MB, Backblaze B2 free
tier is 10 GB) is a bucket + key from the board, then
`restic init --repo s3:...` and `restic copy` (or point `RESTIC_REPOSITORY` at
the bucket and re-run the nightly job). One env change, one green run, drill
re-runs unchanged. This is the only backup item still open.

Drill gotcha: the drill leaves scratch containers publishing `127.0.0.1:3100`.
`assert-containers.sh` (run by `verify.sh` on every deploy) fails on any
container outside the compose project publishing outside proxy 80/443 +
loopback 3000, so a drill overlapping a deploy makes that deploy's rollback
verification fail (observed in run `45758034793` attempt 1). Remove the scratch
containers when the drill finishes, or run it outside a deploy window.


Backup, on demand (the timer does this nightly):

```sh
sudo systemctl start reemco-backup.service
sudo tail -40 /var/log/reemco/backup.log      # "backup done snapshot=<id>"
sudo bash -c 'set -a; . /etc/reemco/backup.env; set +a; restic snapshots'
```

Restore drill — restores the latest snapshot into a scratch dir and verifies a
sample of metrics/events/collect against the live volumes. Writes only to the
scratch dir, safe against production:

```sh
sudo bash -c 'set -a; . /etc/reemco/backup.env; set +a; /opt/reemco/scripts/restore-drill.sh'
# optional scratch dir: ... /opt/reemco/scripts/restore-drill.sh /var/tmp/my-scratch
```

Restore into place (disaster recovery, app stopped):

```sh
sudo docker compose -f /opt/reemco/compose.prod.yml stop app
sudo bash -c 'set -a; . /etc/reemco/backup.env; set +a; restic restore latest --target /'
sudo docker compose -f /opt/reemco/compose.prod.yml --env-file /etc/reemco/release.env \
  --env-file /etc/reemco/image-tag.env up -d
```

## Observability

### Availability record + alert path (REEA-1194)

Two probes, because they answer different questions and one cannot replace the
other:

| | On-box record | External alert |
| --- | --- | --- |
| Unit / workflow | `reemco-uptime.timer` (every 10 min) → `reemco-uptime.service` → `/opt/reemco/scripts/uptime-probe.sh` | `.github/workflows/uptime.yml` (schedule `*/30`, plus `workflow_dispatch` with a `base_url` override) |
| What it records | `/api/health` (code, seconds, build stamp, `ok`) and `/__commit.txt` (code, seconds, 40-char stamp), one JSON line per run | the same two routes **plus** `/`, `/search`, `/results` — one machine-readable line per check in the run log and the job summary |
| Where the record lives | `/var/log/reemco/uptime.jsonl` (self-rotating at 20 MB, one previous file kept) | the Actions run log + step summary for that run id |
| Where the alert lands | `/var/log/reemco/uptime-alerts.log` + a failed systemd unit (journal). Not a human channel by itself. | a GitHub issue labeled `uptime-alert` in this repo (deduped; later failures append to the open issue), i.e. the repo notification stream |
| Survives the box dying | no | **yes** — this is the only probe that can report the box being down |

Simulate the external alert path (does not touch production):

```sh
gh workflow run uptime.yml -f base_url=https://ns539626.ip-144-217-72.net:9
gh run list --workflow=uptime.yml --limit 1
gh issue list --label uptime-alert --state all
```

**Measured limitation — read this before relying on the alert.** GitHub
throttles scheduled workflows on this repo: between 2026-11-19 and 2026-11-26
the `*/30` uptime probe produced **15 runs** and the `*/15` stamp-parity probe
**16 runs** (≈ 2–3/day instead of 48/96). Worst-case detection of a dead box is
therefore hours, not 30 minutes. The 10-minute on-box record covers the
resolution while the box is alive; the cheapest close for box-loss detection is
a free external monitor (e.g. UptimeRobot free tier, 5-minute checks, email/SMS
alert) pointed at `/api/health` and `/__commit.txt` — no secret on the box and
no new server, so it stays inside the "no second server" constraint. Needs one
human signup; flagged to the CEO in [REEA-1194](/REEA/issues/REEA-1194).

### 7-day retrospective (best available evidence, 2026-11-19 → 26)

The box is **3.4 days old as production** (cutover 2026-11-22 18:21Z), so no
7-day on-box record can exist yet. What the existing evidence shows:

| Window | `/api/health` | `/__commit.txt` | Source |
| --- | --- | --- | --- |
| 2026-11-19 → 11-21 | unreachable (`STAMP_UNREACHABLE`, `/` → 402) | unreachable | 7 stamp-parity runs, 6 uptime runs — the box was not production yet (Vercel era); expected, not an outage |
| 2026-11-22 | box comes up 18:21Z; loopback health 200 at 19:47Z | served | journal + manual run |
| 2026-11-23 → 11-26 | **200 on every probe** (health journal 2/day + 9 external runs, build stamp present) | **200 on every probe** (9 external runs, stamp read) | journal + stamp-parity/uptime run logs |

No failed probe after the cutover; the only failures in the window are the
pre-cutover "box not live yet" ones. Continuous production uptime observed:
**3 days 9 hours**, 0 failed probes. The `reemco-uptime.timer` started
2026-11-26 turns this into a durable 10-minute record going forward.

Other observability that already exists:

- `reemco-health.timer` hits `/api/health` at 08:17 and 14:57 UTC (the two
  legacy cron slots) via loopback.
- `reemco-backup.timer` runs nightly at 03:23 UTC when `/etc/reemco/backup.env`
  exists; without it the unit no-ops rather than failing red. The run is green
  and logged to `/var/log/reemco/backup.log` (snapshot id included).
- Deploy/rollback output appends to `/var/log/reemco/deploy.log`; container logs
  are rotated by the daemon config (`20m × 5`).
- External uptime probe (`uptime.yml`) probes this box through `PROD_BASE_URL`.
  It is the only production surface (REEA-1076 removed the Vercel alias).


## Still owned by the CEO (blocking cutover, not this commit)

- Off-box backup **target** (S3/B2/R2 bucket or rsync host) + its credentials.
  **Decided 2026-11-22:** accept the on-box repository for now. No longer
  blocking; the backup itself is live and drill-verified. Revisit when the data
  grows or before a provider-side migration — the swap is one line in
  `/etc/reemco/backup.env`.
- Who can flip the DNS A record.
- Confirm the provider means mdadm soft RAID, not fake RAID.

## Standup record — 2026-11-22 (REEA-1044)

Host: `ns539626.ip-144-217-72.net` (`144.217.72.236`), Ubuntu 26.04.1 LTS,
mdadm RAID1 across both NVMe disks (`md1`/`md2`/`md3` all `[UU]`, ~467 GB on
`/`). Converged with `ansible-playbook -i localhost, -c local` (ok=23,
failed=0): Docker CE `29.10.0` + Compose `5.8.0` from Docker's apt repo,
fail2ban, UFW deny-inbound with 22/80/443 only, chrony synced, unattended
upgrades active, `deploy` user in the docker group, health/backup timers
installed. Caddy obtained a Let's Encrypt certificate for the hostname and
serves the app over HTTPS.

The 26.04 delta checks passed on real hardware: `sudo` is sudo-rs 0.2.13 and
`sudo -n` works for our script forms; coreutils is the uutils build and the
deploy/verify/rollback scripts ran under it unchanged; `chronyc tracking`
reports a synced source; `sshd -T` shows key-only auth (`passwordauthentication
no`, `permitrootlogin prohibit-password`).

Deploy path during standup: the image is built **on the host** from the
committed tree (`docker build -f infra/Dockerfile --build-arg REEMCO_COMMIT=<sha>`)
because the GHCR package is private and the host has no registry credentials.
`release.env` therefore sets `REEMCO_IMAGE_REPO=reemco/app`; `deploy.sh`
accepts a failed `pull` only when that exact tag already exists locally, and
`rollback.sh` redeploys the recorded previous tag.

KV: the app now speaks RESP directly to the local Valkey container
(`REDIS_URL=redis://redis:6379/0`, set by `compose.prod.yml`; code in
`src/lib/collect/kv-redis.ts`). No Upstash, no REST gateway, no hosted store,
no extra npm dependency. Valkey is on the private compose network only, AOF on
a named volume, memory capped at 384 MB with `allkeys-lru`. The old
`hiett/serverless-redis-http` gateway was removed: its `latest` image answered
404 for the Upstash path-style commands the app issues, so every KV call
degraded to the per-container `/data` store. `KV_REST_API_URL`/`KV_REST_API_TOKEN`
remain supported for any deployment that binds a hosted KV store (the retired
Vercel one included); with `REDIS_URL` present it wins (kv.ts selection order).

`/api/health` is pinned to `REEMCO_HEALTH_ORIGIN=http://127.0.0.1:3000`: the
public-surface hops (DNS/TLS/proxy) are asserted by `verify.sh` and the smoke
suite, so the scheduled probe does not need NAT hairpin to reach itself. The
pre-fix image (tag `bcbcb53`) derived the origin from the request URL, which on
this box means the public hostname and produced intermittent `fetch failed`
verdicts; the deployed tag from this change fixes that.

### Verified deploy — 2026-11-22 (REEA-1044)

- Deployed tag `f79fe45` (main head, built on the host). `verify.sh`: commit
  stamp OK, 4/4 security headers, `/api/health` 200 through the public proxy.
- Rollback drill: `rollback.sh` moved `f79fe45 → ec96082`, passed the identical
  gate, then `f79fe45` was redeployed and re-verified. The recorded rollback
  target is `/etc/reemco/image-tag.prev.env` (`ec96082`).
- Local Redis is live: `dbsize` grew 69 → 91 → 118 under real shopper traffic;
  keys `metrics:weekly:v2:*`, `seen:*`, `collect:*`, `pc:*`, `ratelimit`,
  `events`. No `kv-rest` container remains.
- Scheduled probe: a manual `reemco-health.service` run returned `health 200 in
  18.2s`; the timer stays at 08:17/14:57 UTC.
- The health walk legitimately returns 503 on a cold/first sample (live retailer
  adapters, `cards=0`); `verify.sh` now retries 5×45 s instead of false-failing
  a healthy artifact, which is what happened on the first standup attempt.

### Backup + restore drill — 2026-11-22 (REEA-1048)

- Found and fixed a real defect before the first backup ever ran: `backup.sh`
  defaulted to `/data/events /data/metrics /data/collect`, but the host has no
  `/data` — those are in-container paths. Pointed it at the docker volume
  mountpoints and added a fail-fast path check, so a path typo cannot silently
  shrink the backup.
- `/etc/reemco/backup.env` created (0640 root:root) with an interim on-box
  repository `/var/backups/reemco-restic`; `restic.pass` is 0600 root:root and
  escrowed in Paperclip Secrets. `systemctl start reemco-backup.service` exited
  0 and wrote snapshot `fff60062` (334 files, 13.6 MiB processed, `restic check`
  clean).
- Board decision recorded: keep the on-box repository for now
  ([REEA-1048](/REEA/issues/REEA-1048), 2026-11-22). That is an explicit,
  documented acceptance of the residual risk, not a silent gap; the swap to an
  off-box bucket stays a one-line change whenever it is revisited.
- Restore drill: `restore-drill.sh` restored `fff60062` to
  `/var/tmp/reemco-restore-drill` and verified the sample — `metrics.json`,
  `last-seen.json`, `completed-jobs.json`, `job-snapshots.json` byte-identical to
  live; all 59 restored `events.jsonl` lines present in the live volume.
- Rollback/blast radius: backup only reads the volumes; the drill writes only to
  the scratch dir. Nothing in the app path changed.
