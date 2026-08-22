#!/usr/bin/env bash
# WHAT: The Phase 3 PR gate client. Assembles a review request from a PR, sends it to the
#       review broker, and posts the verdict back to the forge as a comment.
# WHY:  This is the piece that runs in CI. It holds no model and no credentials to Ollama —
#       it can only ask the broker for a review, which is what preserves the isolation
#       invariant in CLAUDE.md section 3.
#
# ADVISORY BY DESIGN (2026-08-09). It posts findings and always exits 0 unless the gate
# itself malfunctioned. It does NOT block merges yet. James's call: run advisory until the
# false-positive rate is known, THEN wire into branch protection — otherwise the escape
# hatch built for an untrusted gate becomes permanent.
#
# Every stage reports what it examined, and refuses to report success on an empty scan.
#
# Usage: bin/review-pr.sh --pr N [--base main] [--repo owner/name] [--no-post]
set -euo pipefail

FORGE_API="${FORGE_API:-http://100.88.14.2:3300/api/v1}"
BROKER="${BROKER_URL:-http://100.88.14.2:3401}"
REPO="${REVIEW_REPO:-jfcadm/sovereign-forge}"
BASE="main"
PR=""
POST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --no-post) POST=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PR" ] || { echo "usage: $(basename "$0") --pr N [--base main] [--no-post]" >&2; exit 2; }

die() { echo "GATE ERROR: $*" >&2; exit 1; }

# Credentials come from files or the CI environment, never from argv, so they cannot leak
# into a process list or a job log.
FT="${FORGE_TOKEN:-$(cat "$HOME/.config/sovereign-forge/token" 2>/dev/null || true)}"
BT="${BROKER_TOKEN:-}"
if [ -z "$BT" ] && [ -r "$HOME/.config/sovereign-forge/broker.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$HOME/.config/sovereign-forge/broker.env"
  set +a; BT="${BROKER_TOKEN:-}"
fi
[ -n "$FT" ] || die "no forge token"

HEAD_SHA=$(git rev-parse HEAD)
echo "── reviewing $REPO PR #$PR at ${HEAD_SHA:0:8} (base $BASE)"

# ---- 1. changed files. An empty diff is UNKNOWN, never a pass. --------------------
CHANGED=()
while IFS= read -r _f; do [ -n "$_f" ] && CHANGED+=("$_f"); done \
  < <(git diff --name-only "$BASE...HEAD")
[ "${#CHANGED[@]}" -gt 0 ] || die "no files changed vs $BASE — refusing to report a clean review of nothing"
echo "   changed: ${#CHANGED[@]} file(s)"

# ---- 2. blast radius. Its own positive control; non-zero exit means UNKNOWN. ------
BR_JSON=$(bin/blast-radius.py --json --changed-from "$BASE") \
  || die "blast-radius resolver failed its positive control — dependency scan is UNKNOWN, not empty"
BR_COUNT=$(echo "$BR_JSON" | jq '.blast_radius | length')
BR_SCANNED=$(echo "$BR_JSON" | jq '.files_scanned')
echo "   blast radius: $BR_COUNT dependent(s) from $BR_SCANNED file(s) scanned"

# Context byte budget, scaled by dependent count. A flat 30KB-per-file cap works for a
# typical small blast radius, but blast-radius.py counts a documentation CITATION as a
# dependent by design (see its own header: "a runbook documenting [a file] IS a
# dependent") — a heavily-cross-referenced file (a CLAUDE.md, a widely-imported module)
# can legitimately match 100+ files, and 30KB times that many blows review-broker.py's
# MAX_BYTES=400,000 outright (found 2026-08-17: 184 dependents -> 2.37MB, hard 413).
# Worse, this was never purely a pathological-input problem: a routine ~29-file blast
# radius was ALREADY at 351,966/400,000 under the flat cap alone, before the diff itself
# — this budget exists to keep that from being one dependent away from failing on an
# unrelated future PR, not just to patch the CLAUDE.md case that first exposed it.
# CONTEXT_BUDGET reserves headroom below the broker's cap for the diff + standards + JSON
# structural overhead; the per-file share only shrinks below the current 30KB default
# once the dependent count actually requires it, so a typical small blast radius is
# unaffected. Keep this in sync with review-broker.py's MAX_BYTES by inspection — they
# are separate processes with no shared import, same coupling family as the gate's
# comment template and forge-pr's parser (CLAUDE.md section 3).
#
# CONTEXT_CAP_MIN is a floor on the per-file share. Not reachable against claudeclaw
# today (BR_COUNT tops out near its ~1,215 tracked files, giving 300000/1215≈246 well
# above the floor) but astgl-articles is 372,600 lines (CLAUDE.md §4) — a big enough
# blast radius there drives SHARE toward useless-small or, past BR_COUNT=300,000,
# integer-division zero (caught by this repo's own gate reviewing this exact diff: a
# CONTEXT_CAP of 0 means `head -c 0` — empty content for every context file, technically
# non-crashing but pointless). Raising the per-file floor above the "fair share" can only
# push the total over CONTEXT_BUDGET if enough files are sent at that floor — the
# file-count budget below independently caps that at MAX_CONTEXT_FILES_CAP (120), so the
# worst case is bounded at 119 * 500 = 59,500 bytes, nowhere near the 400,000 broker cap.
# The two budgets are computed independently but rely on each other's ceiling here.
CONTEXT_BUDGET=300000
CONTEXT_CAP=30000
CONTEXT_CAP_MIN=500
if [ "$BR_COUNT" -gt 0 ]; then
  SHARE=$((CONTEXT_BUDGET / BR_COUNT))
  if [ "$SHARE" -lt "$CONTEXT_CAP_MIN" ]; then
    CONTEXT_CAP=$CONTEXT_CAP_MIN
  elif [ "$SHARE" -lt "$CONTEXT_CAP" ]; then
    CONTEXT_CAP=$SHARE
  fi
fi

# Context FILE-COUNT budget — independent of the byte budget above. The broker enforces
# TWO separate caps (review-broker.py MAX_BYTES=400,000 OR MAX_FILES=120, either one
# fails the request), and a large blast radius can blow the file-count cap even once the
# byte cap is satisfied (found 2026-08-17 testing PR jfcadm/claudeclaw#931 against this
# fix: 184 dependents + 4 changed = 188 files, comfortably under budget in bytes at
# 327,563, still hard-rejected at 188 > 120). Cap context to whatever's left of the
# 120-file budget after the actual changed files, which must never be dropped. The
# selection below is blast-radius.py's own output order (alphabetical — see its `sorted()`
# in main()), not a relevance ranking; a smarter "closest to the change" ordering would
# be a real improvement but isn't built yet — this is a known simplification, not a
# considered design. Reported explicitly on the console line below rather than silently
# — a partial-context PR should be visible to whoever reads the CI log, even though
# (unlike the diff itself) losing some context files is a real, defensible degradation
# rather than the "reviewed less than it claimed" failure mode this project keeps hitting.
MAX_CONTEXT_FILES_CAP=120
CONTEXT_FILE_LIMIT=$((MAX_CONTEXT_FILES_CAP - ${#CHANGED[@]}))
if [ "$CONTEXT_FILE_LIMIT" -lt 0 ]; then
  CONTEXT_FILE_LIMIT=0
fi
if [ "$BR_COUNT" -gt "$CONTEXT_FILE_LIMIT" ]; then
  echo "   context: capping to $CONTEXT_FILE_LIMIT/$BR_COUNT blast-radius file(s) (file-count budget; $(( BR_COUNT - CONTEXT_FILE_LIMIT )) omitted)"
fi

# ---- 3. standards, lifted from the project's own CLAUDE.md -----------------------
# The differentiator: this gate enforces rules that live in this repo, which no external
# reviewer can see. A missing or empty standards list is a real degradation, so say so.
# The section markers are env-configurable because consuming repos number their CLAUDE.md
# headings differently (astgl-articles has no "## 3." — its standards live under a named
# heading). Defaults preserve this repo's behaviour byte-for-byte.
STANDARDS_BEGIN="${STANDARDS_BEGIN:-^## 3\\.}"
STANDARDS_END="${STANDARDS_END:-^## 4\\.}"
STANDARDS=$(awk -v b="$STANDARDS_BEGIN" -v e="$STANDARDS_END" \
            '$0 ~ b {f=1; next} f && $0 ~ e {f=0} f && /^- \*\*/' CLAUDE.md \
            | sed 's/^- \*\*//; s/\*\*//g' | cut -c1-300 | jq -R . | jq -s .)
STD_COUNT=$(echo "$STANDARDS" | jq 'length')
# Zero standards is a FAILED gate, not a degraded one. A verdict produced without any
# project standards is a generic review wearing this gate's badge, and the whole point is
# enforcing rules that live in this repo. Same family as every other zero-scan in here:
# UNKNOWN, never clean. (Found by the gate reviewing its own diff — rated minor, and the
# only genuine finding in that batch.)
[ "$STD_COUNT" -gt 0 ] \
  || die "extracted ZERO standards from CLAUDE.md — refusing to pass off a generic review as this gate"
echo "   standards: $STD_COUNT extracted from CLAUDE.md"

# ---- 4. build the request ---------------------------------------------------------
REQ=$(mktemp); trap 'rm -f "$REQ"' EXIT
{
  echo '{'
  echo "\"head_sha\": $(printf '%s' "$HEAD_SHA" | jq -R .),"
  echo "\"standards\": $STANDARDS,"
  echo '"changed": ['
  first=1
  for f in "${CHANGED[@]}"; do
    [ $first -eq 1 ] || echo ','
    first=0
    d=$(git diff "$BASE...HEAD" -- "$f" | head -c 60000)
    printf '{"path":%s,"status":"modified","diff":%s}' "$(printf '%s' "$f" | jq -R .)" "$(printf '%s' "$d" | jq -Rs .)"
  done
  echo '],'
  echo '"context": ['
  first=1
  for f in $(echo "$BR_JSON" | jq -r --argjson n "$CONTEXT_FILE_LIMIT" '.blast_radius[:$n][]'); do
    [ -r "$f" ] || continue
    [ $first -eq 1 ] || echo ','
    first=0
    printf '{"path":%s,"content":%s}' "$(printf '%s' "$f" | jq -R .)" "$(head -c "$CONTEXT_CAP" "$f" | jq -Rs .)"
  done
  echo ']}'
} > "$REQ"
jq -e . "$REQ" >/dev/null || die "assembled an invalid request JSON"

# ---- 5. ask the broker ------------------------------------------------------------
V=$(mktemp); trap 'rm -f "$REQ" "$V"' EXIT
code=$(curl -sS -m 900 -o "$V" -w '%{http_code}' -X POST \
       ${BT:+-H "Authorization: Bearer $BT"} -H 'Content-Type: application/json' \
       --data-binary @"$REQ" "$BROKER/review") || die "broker unreachable at $BROKER"

VERDICT=$(jq -r '.verdict // "error"' "$V")
if [ "$VERDICT" = "error" ] || [ "$code" != "200" ]; then
  die "broker returned $code / verdict=$VERDICT :: $(jq -r '.error // "no detail"' "$V")"
fi

EXAMINED=$(jq -r .files_examined "$V"); SUBMITTED=$(jq -r .files_supplied_total "$V")
FINDINGS=$(jq '.findings | length' "$V")
echo "   verdict: $VERDICT — $FINDINGS finding(s), examined $EXAMINED/$SUBMITTED supplied file(s)"

# ---- 6. post it back --------------------------------------------------------------
BODY=$(jq -r --arg sha "${HEAD_SHA:0:8}" --arg br "$BR_COUNT" --arg scanned "$BR_SCANNED" '
  "## 🤖 Local AI review — **" + (.verdict|ascii_upcase) + "**\n\n" +
  "`" + $sha + "` · model `" + .model + "` · " +
  (.files_examined|tostring) + "/" + (.files_supplied_total|tostring) + " supplied file(s) examined · " +
  $br + " dependent(s) from " + $scanned + " scanned · " +
  (.standards_checked|tostring) + "/" + (.standards_supplied|tostring) + " project standards checked" +
  (if .cached then " · _cached verdict_" else "" end) + "\n\n" +
  (if (.findings|length) == 0 then "No findings in the changed code or its blast radius.\n"
   else ((.findings | map(
     "### " + (if .severity=="critical" then "🔴" elif .severity=="major" then "🟠" else "🟡" end) +
     " " + .severity + " — " + .category + "\n" +
     "**" + .file + (if .line then ":" + (.line|tostring) else "" end) + "** — " + .summary + "\n\n" +
     .why + "\n") | join("\n"))) end) +
  "\n---\n_Advisory only — this gate does not block merges. Reviews the change and the " +
  "files that depend on it, not the whole project._"' "$V")

if [ "$POST" -eq 1 ]; then
  pc=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: token $FT" \
       -H 'Content-Type: application/json' \
       --data-binary "$(jq -n --arg b "$BODY" '{body:$b}')" \
       "$FORGE_API/repos/$REPO/issues/$PR/comments")
  [ "$pc" = "201" ] || die "could not post the review comment (HTTP $pc) — the review ran but nobody will see it"
  echo "   posted to $REPO PR #$PR"
else
  echo "$BODY"
fi

# Advisory: a real verdict, even "fail", is a successful RUN of the gate.
exit 0
