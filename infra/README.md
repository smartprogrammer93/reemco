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
| `compose.prod.yml` | app + Valkey + optional on-box Upstash-REST gateway + Caddy |
| `Caddyfile` | TLS + HSTS; app owns CSP/CTO/Referrer-Policy (do not duplicate them) |
| `Dockerfile` | Production image, tag = commit sha, standalone Next output |
| `scripts/deploy.sh` | Deploy a pinned tag, auto-rollback on failed verify |
| `scripts/rollback.sh` | Redeploy the recorded previous tag, same verify gate |
| `scripts/verify.sh` | Commit stamp + 4 security headers + health |
| `scripts/backup.sh` | Off-box restic backup of durable state |
| `systemd/` | `/api/health` probe timers (replaces `vercel.json` crons) + daily backup |
| `app.env.example` | Runtime **secrets** → `/etc/reemco/app.env` (0640) |
| `release.env.example` | Non-secret site config → `/etc/reemco/release.env` (0640) |

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
or hostname. The workflow builds `ghcr.io/<repo>:<sha>`, syncs `infra/` to the
host, runs `deploy.sh --tag <sha>`, and verifies stamp + headers + smoke from
outside the box.

Manual equivalent on the host: `sudo /opt/reemco/scripts/deploy.sh --tag <sha>`.

## Rollback

Run the same workflow with `rollback_sha` = the previous known-good commit
(no rebuild — it redeploys the existing artifact). On-host equivalent:
`sudo /opt/reemco/scripts/rollback.sh` (uses `/etc/reemco/image-tag.prev.env`,
written by every deploy). If the box itself is unreachable, the cutover
rollback is the DNS A record back to Vercel while that deployment stays live.

**No rollback path, no deploy.**

## Observability

- `reemco-health.timer` hits `/api/health` at 08:17 and 14:57 UTC (the two
  `vercel.json` cron slots) via loopback.
- `reemco-backup.timer` runs nightly at 03:23 UTC when `/etc/reemco/backup.env`
  exists; without it the unit no-ops rather than failing red.
- Deploy/rollback output appends to `/var/log/reemco/deploy.log`; container logs
  are rotated by the daemon config (`20m × 5`).
- External uptime probe (`uptime.yml`) is repointed at the new host during the
  parallel run; keep it on Vercel until DNS cutover.

## Still owned by the CEO (blocking cutover, not this commit)

- Off-box backup target + credentials (`RESTIC_REPOSITORY`, password file).
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

KV: `hiett/serverless-redis-http` is running (profile `local-kv`) but its
`latest` image answers 404 for the Upstash path-style commands the app uses
(`/get/<key>`, `/incrby/<key>/<n>`, `/keys/<pattern>`), so `app.env` leaves
`KV_REST_API_URL`/`KV_REST_API_TOKEN` empty and the app uses its durable
on-box store under `/data/*` (single instance, so no cross-instance blindness).
Follow-up: inject hosted Upstash credentials, or pin a gateway build that
implements the path contract, then set the two vars back.

`/api/health` is pinned to `REEMCO_HEALTH_ORIGIN=http://127.0.0.1:3000`: the
public-surface hops (DNS/TLS/proxy) are asserted by `verify.sh` and the smoke
suite, so the scheduled probe does not need NAT hairpin to reach itself.
