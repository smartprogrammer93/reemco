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
| `Caddyfile` | TLS + HSTS; app owns CSP/CTO/Referrer-Policy (do not duplicate them) |
| `Dockerfile` | Production image, tag = commit sha, standalone Next output |
| `scripts/deploy.sh` | Deploy a pinned tag, auto-rollback on failed verify |
| `scripts/rollback.sh` | Redeploy the recorded previous tag, same verify gate |
| `scripts/verify.sh` | Commit stamp + 4 security headers + health + container hardening assertions |
| `scripts/assert-compose-hardening.sh` | CI gate: renders the compose file and asserts the hardening invariants |
| `scripts/assert-containers.sh` | Post-deploy `docker inspect` assertions on the running stack (called by `verify.sh`) |
| `scripts/backup.sh` | Restic backup of the durable state (docker volumes + `/opt/reemco` + `/etc/reemco`) |
| `scripts/restore-drill.sh` | Restore latest snapshot to a scratch dir and verify the sample against live volumes |
| `systemd/` | `/api/health` probe timers (replaces `vercel.json` crons) + daily backup |
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
written by every deploy). If the box itself is unreachable, the cutover
rollback is the DNS A record back to Vercel while that deployment stays live.

**No rollback path, no deploy.**

## Deploy gate — what blocks, what is advisory, who changes it

Owner: **DevOps Engineer**. This section is the single place the gate's split is
written down; a change to it is a reviewed diff to
`.github/workflows/deploy-selfhosted.yml` **plus this section in the same commit**.
Never edit the gate by hand on the box — every deploy overwrites `/opt/reemco`
from git.

**Blocking — a failure fails the deploy and takes the rollback path:**

1. Production dependency audit gate — `npm audit --omit=dev --audit-level=high` on
   the committed lockfile (skipped only for an explicit `rollback_sha`, which
   redeploys an already-verified commit).
2. Compose hardening invariants — `infra/scripts/assert-compose-hardening.sh`
   (cap_drop ALL / non-root, digest-pinned infra images, segmented networks).
3. On-host build of the pinned commit tag.
4. Deploy of the pinned tag — `deploy.sh` auto-rolls-back if its on-box verify fails.
5. Public-surface verification — served `/__commit.txt` must equal the intended SHA
   and all four security headers (CSP, X-Content-Type-Options, Referrer-Policy, HSTS)
   must be present.
6. Funnel smoke suite (`npm run smoke`: home → results → click-out, freshness, 375px
   mobile pass, offer link-health, adapter-registration parity, cache headers).
   Restored to blocking in REEA-1059 after the two deterministic failures that had made
   it advisory were fixed: step 5 now proves reachability inside the deliberately
   scrollable coverage row instead of failing on it (REEA-1056), and step 7 no longer
   requires the retired PC Kuwait lane (REEA-901).

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

**Rolling back this change.** Compose/Caddy changes are versioned: redeploy the
previous commit through the deploy workflow with `rollback_sha` (it re-syncs
`/opt/reemco` from that ref, so the old stack shape comes back), then run
`sudo /opt/reemco/scripts/verify.sh --tag <sha>`. The pre-change files were
copied to `/opt/reemco/backup/reea1061-20261122T222355Z/` on the box as a
belt-and-braces restore path.

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

- `reemco-health.timer` hits `/api/health` at 08:17 and 14:57 UTC (the two
  `vercel.json` cron slots) via loopback.
- `reemco-backup.timer` runs nightly at 03:23 UTC when `/etc/reemco/backup.env`
  exists; without it the unit no-ops rather than failing red. The run is green
  and logged to `/var/log/reemco/backup.log` (snapshot id included).
- Deploy/rollback output appends to `/var/log/reemco/deploy.log`; container logs
  are rotated by the daemon config (`20m × 5`).
- External uptime probe (`uptime.yml`) is repointed at the new host during the
  parallel run; keep it on Vercel until DNS cutover.

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
remain supported for a Vercel deployment that binds a hosted store; with
`REDIS_URL` present it wins (kv.ts selection order).

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
