#!/bin/sh
# REEA-337: start the repo's self-hosted runner (Hobby hosted minutes are capped;
# this runner has zero minute cost). Idempotent: skip if already listening.
# Host: any always-on box; data dir is $(dirname)/../runner (extract the linux-x64
# actions/runner tarball there once, then this script only starts it).
RUNDIR="${RUNDIR:-/tmp/reemco-runner}"
cd "$RUNDIR" || exit 1
HOME=/tmp DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 LD_LIBRARY_PATH="$RUNDIR/bin" ./run.sh >> /tmp/runner.log 2>&1 &
echo "runner started pid=$!"
