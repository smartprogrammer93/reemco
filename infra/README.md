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
