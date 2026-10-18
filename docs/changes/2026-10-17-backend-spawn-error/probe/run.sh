#!/bin/zsh
# WHAT: Runs the Electron probe with a temp appData holding a dummy config (distinctive
# fake instanceSecret) and a non-executable dummy binary; greps all output for the secret.
# WHY: never touches the user's real appData or the shared ~/.cache binary.
set -u
REPO=$1; OUT=$2
SECRET="probesecret$(date +%s)deadbeef"
A=$(mktemp -d); mkdir -p "$A/Geekspace/convex"
printf '{"deploymentName":"probe","instanceSecret":"%s","adminKey":"probeadmin"}' "$SECRET" > "$A/Geekspace/convex/config.json"
BIN="$A/fake-backend"; printf 'not a binary' > "$BIN"; chmod 644 "$BIN"
start=$(date +%s)
PROBE_APPDATA=$A PROBE_REPO=$REPO GEEKSPACE_CONVEX_BINARY=$BIN \
  "$REPO/node_modules/.bin/electron" "${0:A:h}/main.mjs" > "$OUT" 2>&1
rc=$?
echo "rc=$rc wall=$(( $(date +%s) - start ))s"
echo "positive control '[probe': $(grep -c '\[probe' "$OUT")"
echo "secret hits in stdout/stderr: $(grep -cF "$SECRET" "$OUT")"
echo "secret hits in convex.log: $(grep -cF "$SECRET" "$A/Geekspace/logs/convex.log")"
echo "grep-by-value positive control (config.json): $(grep -cF "$SECRET" "$A/Geekspace/convex/config.json")"
grep -F "$SECRET" "$OUT" | sed "s/$SECRET/<SECRET>/g" | head -5
rm -rf "$A"
