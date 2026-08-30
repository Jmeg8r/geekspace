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
# Every stage reports what it examined, and refuses to report success on an empty scan —
# or on a PARTIAL one: an over-cap file diff, or a model that read fewer files than it was
# given, fails the gate rather than shipping a PASS that covers less than it claims.
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

# Credentials come from files or the CI environment, and reach curl through a mode-0600
# header file (-H @file), never on argv — argv is world-readable through a process list
# for the whole life of the request, which for the broker call is up to 900s. This
# comment used to describe an intention the code did not implement: both tokens were
# interpolated straight into curl's argument list (Codex [P2]).
FT="${FORGE_TOKEN:-$(cat "$HOME/.config/sovereign-forge/token" 2>/dev/null || true)}"
BT="${BROKER_TOKEN:-}"
if [ -z "$BT" ] && [ -r "$HOME/.config/sovereign-forge/broker.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$HOME/.config/sovereign-forge/broker.env"
  set +a; BT="${BROKER_TOKEN:-}"
fi
# The forge credential is spent ONLY on the comment POST below. Demanding it up
# front also fired in --no-post mode, which is documented in the usage line and
# needs nothing but the broker — so a valid local review died on a credential it
# was never going to use (Codex [P3]). Still checked before the 900s broker call
# rather than after it: a review nobody can post is worth failing fast on.
if [ "$POST" -eq 1 ] && [ -z "$FT" ]; then
  die "no forge token — needed to post the review comment (pass --no-post to print it instead)"
fi

HEAD_SHA=$(git rev-parse HEAD)
echo "── reviewing $REPO PR #$PR at ${HEAD_SHA:0:8} (base $BASE)"

# ---- 1. changed files. An empty diff is UNKNOWN, never a pass. --------------------
# NOT `git diff --name-only`: for a detected rename that prints only the DESTINATION,
# so the old path never reaches the model and never reaches the blast-radius scan. The
# file then renders as a plain addition and every caller still importing the old name
# goes unexamined — a rename that breaks its callers earns a clean verdict. Observed on
# mcp-techkb PR #13, which carried an R100 of .github/workflows/secret-scan.yml to
# .forgejo/ and was passed by this gate with the defect in force (Codex [P1], 2026-08-29).
#
# --name-status -z gives both halves. Rename detection stays ON deliberately: the loop in
# 4a diffs ONE path at a time, and a path-limited diff is resolved BEFORE renames are
# paired up, so the old path yields its full deletion diff and the new path its full
# addition diff — both reviewed in full. Asking for both paths in a SINGLE diff is what
# collapses to a 197-byte "similarity index 100%" stub that reviews nothing, and that is
# why --no-renames is not the fix here.
#
# -z because the status and paths are NUL-delimited: a path containing a space, a quote
# or a newline is legal in git and would otherwise be split or shell-quoted into a name
# that matches no file on disk.
#
# -M -C -l0 because detection must not depend on the consuming repo's git config: each
# flag closes a different way the config turns it off, all measured on git 2.50.1.
#   -M   under diff.renames=false a move emits separate D/A records and the rename is
#        invisible again — the defect above wearing a different hat.
#   -C   -M ALONE overrides diff.renames=copies and turns a detected copy back into a
#        plain addition, silently disabling the C branch below.
#   -l0  diff.renameLimit caps the exhaustive pass: at renameLimit=1 a fixture of four
#        moved-and-edited files dropped from 4 R records to 0 even WITH -M -C. Applies
#        to INEXACT renames (moved AND edited); an exact rename is paired in a cheap
#        pre-pass no limit touches, so the R100 above was never at risk — "moved it and
#        tweaked it" is, and is the more common shape.
# mcp-techkb and astgl-articles get a byte-identical copy of this script, so their local
# git config is not part of its contract (Codex [P2], 2026-08-29).
CHANGED=()
CHANGED_STATUS=()
while IFS= read -r -d '' _st; do
  IFS= read -r -d '' _p1 \
    || die "git diff --name-status ended mid-record after status '$_st' — refusing to review a truncated file list"
  case "$_st" in
    R*)
      # Rename: <status>\0<source>\0<destination>\0. Both are reviewed, and each side's
      # status names the other so the model can see the move rather than a coincidental
      # delete-plus-add.
      IFS= read -r -d '' _p2 \
        || die "git diff --name-status gave '$_st' for '$_p1' with no destination path — refusing to review a truncated file list"
      CHANGED+=("$_p1"); CHANGED_STATUS+=("deleted by rename to $_p2")
      CHANGED+=("$_p2"); CHANGED_STATUS+=("added by rename from $_p1")
      ;;
    C*)
      # COPY is not a rename: the source still exists and still says what it said, so
      # only the DESTINATION is part of this change. Lumping C in with R labelled a
      # live file "deleted by rename" — false metadata handed to the model — and
      # submitted its path-limited diff, which is empty, as a file the model would
      # still count as examined (Codex [P2], 2026-08-29). Only reachable when copy
      # detection is on (diff.renames=copies or -C), hence latent until now.
      IFS= read -r -d '' _p2 \
        || die "git diff --name-status gave '$_st' for '$_p1' with no destination path — refusing to review a truncated file list"
      CHANGED+=("$_p2"); CHANGED_STATUS+=("added by copy from $_p1")
      ;;
    A*) CHANGED+=("$_p1"); CHANGED_STATUS+=("added") ;;
    D*) CHANGED+=("$_p1"); CHANGED_STATUS+=("deleted") ;;
    T*) CHANGED+=("$_p1"); CHANGED_STATUS+=("typechange") ;;
    *)  CHANGED+=("$_p1"); CHANGED_STATUS+=("modified") ;;
  esac
done < <(git diff --name-status -z -M -C -l0 "$BASE...HEAD")
[ "${#CHANGED[@]}" -gt 0 ] || die "no files changed vs $BASE — refusing to report a clean review of nothing"
echo "   changed: ${#CHANGED[@]} path(s)"

# ---- 2. blast radius. Its own positive control; non-zero exit means UNKNOWN. ------
BR_JSON=$(bin/blast-radius.py --json --changed-from "$BASE") \
  || die "blast-radius resolver failed its positive control — dependency scan is UNKNOWN, not empty"
BR_COUNT=$(echo "$BR_JSON" | jq '.blast_radius | length')
BR_SCANNED=$(echo "$BR_JSON" | jq '.files_scanned')
echo "   blast radius: $BR_COUNT dependent(s) from $BR_SCANNED file(s) scanned"

# Context FILE-COUNT budget — independent of the byte budget below. The broker enforces
# TWO separate caps (review-broker.py MAX_BYTES=400,000 OR MAX_FILES=120, either one
# fails the request), and a large blast radius can blow the file-count cap even once the
# byte cap is satisfied (found 2026-08-17 testing PR jfcadm/claudeclaw#931 against this
# fix: 184 dependents + 4 changed = 188 files, comfortably under budget in bytes at
# 327,563, still hard-rejected at 188 > 120). Cap context to whatever's left of the
# 120-file budget after the actual changed files, which must never be dropped. The
# selection below is blast-radius.py's own output order (alphabetical — see its `sorted()`
# in main()), not a relevance ranking; a smarter "closest to the change" ordering would
# be a real improvement but isn't built yet — this is a known simplification, not a
# considered design. Reported explicitly on the console line in step 4b rather than silently
# — a partial-context PR should be visible to whoever reads the CI log, even though
# (unlike the diff itself) losing some context files is a real, defensible degradation
# rather than the "reviewed less than it claimed" failure mode this project keeps hitting.
MAX_CONTEXT_FILES_CAP=120
CONTEXT_FILE_LIMIT=$((MAX_CONTEXT_FILES_CAP - ${#CHANGED[@]}))
if [ "$CONTEXT_FILE_LIMIT" -lt 0 ]; then
  CONTEXT_FILE_LIMIT=0
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

# ---- 4a. the changed-file diffs, MEASURED as they are built -----------------------
REQ=$(mktemp); DTMP=$(mktemp); CJSON=$(mktemp); trap 'rm -f "$REQ" "$DTMP" "$CJSON"' EXIT
# The context budget in 4b is derived from this measurement instead of a fixed guess
# at what the diff would cost. It used to be a guess: CONTEXT_BUDGET was a flat
# 300,000, which silently assumed the diff plus everything else would fit in the
# remaining 100,000. But the per-file diff cap is 60,000 and the changed-file count is
# unbounded, so two large changed files plus a routine ten-dependent blast radius came
# to ~420,000 against the broker's 400,000. The broker refuses rather than trims, so
# the whole request is rejected, the gate dies with no verdict, and forge-pr fails
# closed on the missing verdict — a merge blocked by arithmetic nobody could see.
# Codex [P2].
DIFF_CAP=60000
DIFF_BYTES=0
{
  first=1
  for i in "${!CHANGED[@]}"; do
    f="${CHANGED[$i]}"; st="${CHANGED_STATUS[$i]}"
    [ $first -eq 1 ] || echo ','
    first=0
    # Written to a FILE, never `git diff … | head -c`: head closes the pipe once it
    # has its cap, git takes SIGPIPE, and `set -euo pipefail` turns that into exit
    # 141 that kills the WHOLE gate. Any PR carrying a single-file diff larger than
    # the cap therefore died here, before the broker was ever called — the gate
    # produced no review at all while reporting a plain CI failure. Observed on
    # claudeclaw #944: three runs at three different heads, all exit 141 immediately
    # after "standards: N extracted", misdiagnosed for a week as an Ollama outage.
    git diff "$BASE...HEAD" -- "$f" > "$DTMP"
    fsz=$(wc -c < "$DTMP" | tr -d '[:space:]')
    # An over-cap diff FAILS THE GATE; it is never sent as a prefix. `head -c` used to
    # silently drop every hunk past byte 60,000 while the request still listed the file
    # as supplied and the model still counted it as examined — so a defect at byte
    # 60,001 produced a PASS / "No findings" comment that satisfied forge-pr. That is
    # the same "reviewed less than it claimed" failure the whole-request check below
    # was written against, arriving one level down (Codex [P1], 2026-08-29). Refusing
    # here is what keeps truncation visible in the verdict instead of silent.
    if [ "$fsz" -gt "$DIFF_CAP" ]; then
      die "$f: diff is $fsz bytes, past the ${DIFF_CAP}-byte per-file cap — split the PR. Sending its first $DIFF_CAP bytes would review less than it claims while still reporting the file as examined, which is the failure this gate exists to prevent"
    fi
    # The diff goes to jq STRAIGHT FROM THE FILE. `d=$(cat "$DTMP")` stripped the
    # trailing newline — command substitution always does — so the last byte of every
    # single diff was dropped while the file was still reported as fully supplied.
    # One byte is not a defect anyone will hit, but it is the same shape as the cap
    # above: send less than is claimed. Measured on a 56,118-byte fixture diff, 56,117
    # arrived. Reading the file twice also removes the need to keep $d and $fsz in step.
    #
    # Counted in BYTES while the broker counts CHARACTERS of the decoded string
    # (review-broker.py sums len() over the parsed diff/content fields). For UTF-8
    # bytes >= characters, so this over-states the cost and can only err toward
    # sending less than the cap allows, never more.
    DIFF_BYTES=$(( DIFF_BYTES + fsz ))
    # jq -Rs, not -R, on the path and the status. -R reads raw input LINE BY LINE, so a
    # value containing a newline comes out as TWO JSON strings and the request stops
    # parsing — `jq: parse error` and a gate that dies with no verdict on a filename git
    # is perfectly happy with. Reachable since --name-status -z started handing over raw
    # paths (--name-only used to pre-quote them into "we\nird.py"), and reachable for the
    # status too, which now carries a rename's counterpart path. Fails closed, so it was
    # never a coverage lie — but a legitimate path should not break the gate.
    printf '{"path":%s,"status":%s,"diff":%s}' "$(printf '%s' "$f" | jq -Rs .)" "$(printf '%s' "$st" | jq -Rs .)" "$(jq -Rs . < "$DTMP")"
  done
} > "$CJSON"

# ---- 4b. context BYTE budget: what is left once the diff is paid for --------------
# Keep BROKER_MAX_BYTES in sync with review-broker.py's MAX_BYTES by inspection — they
# are separate processes with no shared import, the same coupling family as the gate's
# comment template and forge-pr's parser (CLAUDE.md section 3). The margin is headroom
# against that constant drifting, not against the measurement, which is already
# conservative for the reason above.
BROKER_MAX_BYTES=400000
BROKER_SAFETY_MARGIN=20000
CONTEXT_CAP=30000
CONTEXT_CAP_MIN=500
REQUEST_ALLOWANCE=$(( BROKER_MAX_BYTES - BROKER_SAFETY_MARGIN ))
if [ "$DIFF_BYTES" -gt "$REQUEST_ALLOWANCE" ]; then
  die "the changed-file diffs alone are $DIFF_BYTES bytes, past the broker's ${BROKER_MAX_BYTES}-byte cap — split the PR. Trimming the diff to fit would review less than it claims, which is the failure this gate exists to prevent"
fi
CONTEXT_BUDGET=$(( REQUEST_ALLOWANCE - DIFF_BYTES ))
if [ "$BR_COUNT" -gt 0 ]; then
  SHARE=$(( CONTEXT_BUDGET / BR_COUNT ))
  if [ "$SHARE" -lt "$CONTEXT_CAP_MIN" ]; then
    # The budget cannot give every dependent a useful slice. Send FEWER files at the
    # floor rather than more files over budget: raising the per-file cap back up to
    # the floor is precisely what could push the total past the broker's limit, so
    # the file count has to absorb it. (Letting SHARE stand would mean `head -c 0` —
    # every context file present but empty, pointless rather than merely small.)
    CONTEXT_CAP=$CONTEXT_CAP_MIN
    BYTE_FILE_LIMIT=$(( CONTEXT_BUDGET / CONTEXT_CAP_MIN ))
    if [ "$BYTE_FILE_LIMIT" -lt "$CONTEXT_FILE_LIMIT" ]; then
      CONTEXT_FILE_LIMIT=$BYTE_FILE_LIMIT
    fi
  elif [ "$SHARE" -lt "$CONTEXT_CAP" ]; then
    CONTEXT_CAP=$SHARE
  fi
fi
# Every branch above holds files_sent * CONTEXT_CAP <= CONTEXT_BUDGET, so the assembled
# request totals at most REQUEST_ALLOWANCE.
if [ "$BR_COUNT" -gt "$CONTEXT_FILE_LIMIT" ]; then
  echo "   context: capping to $CONTEXT_FILE_LIMIT/$BR_COUNT blast-radius file(s) ($(( BR_COUNT - CONTEXT_FILE_LIMIT )) omitted)"
fi
echo "   budget: diff $DIFF_BYTES B; context <= $CONTEXT_BUDGET B at <= $CONTEXT_CAP B/file (broker cap $BROKER_MAX_BYTES B)"

# ---- 4c. assemble -----------------------------------------------------------------
{
  echo '{'
  echo "\"head_sha\": $(printf '%s' "$HEAD_SHA" | jq -R .),"
  echo "\"standards\": $STANDARDS,"
  echo '"changed": ['
  cat "$CJSON"
  echo '],'
  echo '"context": ['
  first=1
  for f in $(echo "$BR_JSON" | jq -r --argjson n "$CONTEXT_FILE_LIMIT" '.blast_radius[:$n][]'); do
    [ -r "$f" ] || continue
    [ $first -eq 1 ] || echo ','
    first=0
    # -Rs on the path for the same reason as the changed-file entry above.
    printf '{"path":%s,"content":%s}' "$(printf '%s' "$f" | jq -Rs .)" "$(head -c "$CONTEXT_CAP" "$f" | jq -Rs .)"
  done
  echo ']}'
} > "$REQ"
jq -e . "$REQ" >/dev/null || die "assembled an invalid request JSON"

# ---- 5. ask the broker ------------------------------------------------------------
V=$(mktemp); BHDR=$(mktemp); trap 'rm -f "$REQ" "$DTMP" "$CJSON" "$V" "$BHDR"' EXIT
# mktemp creates 0600 (verified on BSD and GNU coreutils), so the token is readable
# only by this user -- unlike argv. An unauthenticated broker leaves the file empty,
# which curl accepts as "no extra headers".
if [ -n "$BT" ]; then printf 'Authorization: Bearer %s\n' "$BT" > "$BHDR"; fi
code=$(curl -sS -m 900 -o "$V" -w '%{http_code}' -X POST \
       -H @"$BHDR" -H 'Content-Type: application/json' \
       --data-binary @"$REQ" "$BROKER/review") || die "broker unreachable at $BROKER"

VERDICT=$(jq -r '.verdict // "error"' "$V")
if [ "$VERDICT" = "error" ] || [ "$code" != "200" ]; then
  die "broker returned $code / verdict=$VERDICT :: $(jq -r '.error // "no detail"' "$V")"
fi

EXAMINED=$(jq -r .files_examined "$V"); SUBMITTED=$(jq -r .files_supplied_total "$V")
EXAMINED_CHANGED=$(jq -r .files_examined_changed "$V")
FINDINGS=$(jq '.findings | length' "$V")
echo "   verdict: $VERDICT — $FINDINGS finding(s), examined $EXAMINED/$SUBMITTED supplied file(s) ($EXAMINED_CHANGED/${#CHANGED[@]} changed)"

# The ratio is ENFORCED here, not merely printed. It used to be printed and nothing
# else: the broker only rejects files_examined=0, forge-pr parses the ratio but decides
# on the verdict word alone (its decide() never reads it), so a model that opened one
# file out of twelve and found nothing produced a PASS that unlocked a merge — the whole
# gate satisfied by 1/12 of a review (Codex [P1], 2026-08-29).
#
# Shape is allowlisted, not spot-checked: anything that is not a run of digits — "null"
# from a field the broker omitted, an empty capture, a float, a negative — is UNKNOWN,
# because `[ x -lt y ]` on a non-integer is a syntax error that `set -e` would turn into
# a bare exit nobody can read as a gate refusal.
case "$EXAMINED" in ''|*[!0-9]*)
  die "broker reported files_examined='$EXAMINED', which is not a count — the size of the review is UNKNOWN, never clean" ;;
esac
case "$SUBMITTED" in ''|*[!0-9]*)
  die "broker reported files_supplied_total='$SUBMITTED', which is not a count — the size of the review is UNKNOWN, never clean" ;;
esac
# Same allowlist, and it is also this client's version check on the broker. A broker older
# than review-verdict@2 does not send the field at all, so jq yields "null" and the gate
# refuses. That is deliberate: the alternative is falling back to files_examined, which
# silently restores the weaker check below and leaves an un-redeployed service looking
# like a working gate. The message names the cause so the refusal is actionable.
case "$EXAMINED_CHANGED" in ''|*[!0-9]*)
  die "broker reported files_examined_changed='$EXAMINED_CHANGED', which is not a count — a broker older than review-verdict@2 does not send this field, so redeploy review-broker.py. This gate will not fall back to files_examined, because that is the weaker check this one replaced" ;;
esac
# What counts as "enough examined" is the CHANGED file count, not the supplied total.
# files_examined counts changed files AND blast-radius files together (review-broker.py
# states this in the prompt), and the context files are supporting material the model is
# not obliged to open — it read 3 of 10 on this gate's own PR #48, being the 3 changed
# files and none of the 7 dependents. Demanding examined == supplied therefore fails
# essentially every PR that has a blast radius at all, and a gate that always fails is
# one that gets routed around, which is worse than the defect it was meant to close.
#
# So the rule is: every CHANGED file must have been read, because those are the subject
# of the review — and it is now checked against a count that can actually express that.
# files_examined could not. It sums the changed files AND the blast-radius files, so
# "examined >= changed" was satisfied by 2 changed files plus 1 dependent while one of the
# changed files went unread: NECESSARY, but not sufficient. review-broker.py now also
# reports files_examined_changed, counting the changed files alone (review-verdict@2). It
# obtains it by asking the model WHICH changed files it read and counting the paths that
# are genuinely in the changed set, so that count cannot exceed the changed-file total and
# no honest pair of counts clears the check below while a changed file was skipped.
#
# "Sufficient" is about the ARITHMETIC ONLY. Both numbers remain the model's self-report:
# it says how many changed files it read and nothing here proves it read them. What is
# closed is the gap where a truthful total concealed an untouched changed file; a model
# that simply lies still passes. Do not let any comment, doc or tool description upgrade
# this into verification.
#
# Only a merge-eligible verdict is gated. forge-pr treats PASS as safe to merge and
# blocks on every other word, so a partial "concerns"/"fail" already stops at the same
# place while its findings stay readable in the posted comment; killing those would cost
# the human the review without buying any safety. Same reason the broker reports this
# shortfall instead of turning it into verdict "error": an error verdict dies above,
# before section 6 posts anything, and destroys findings the human should still see.
if [ "$VERDICT" = "pass" ] && [ "$EXAMINED_CHANGED" -lt "${#CHANGED[@]}" ]; then
  die "model read $EXAMINED_CHANGED of the ${#CHANGED[@]} CHANGED file(s) — a clean verdict on a partial examination is UNKNOWN, not a pass"
fi
# The two counts must also agree with each other. The broker bounds
# files_examined_changed by the CHANGED-file count alone and deliberately does not
# reconcile it against files_examined, precisely so this check has something to catch: the
# two turns are independent self-reports and can disagree. A changed-file count above the
# total is evidence about neither number, and reconciling it upstream would have meant
# reporting a count the model never gave while leaving this guard unable to fire.
if [ "$VERDICT" = "pass" ] && [ "$EXAMINED_CHANGED" -gt "$EXAMINED" ]; then
  die "broker reported files_examined_changed=$EXAMINED_CHANGED against files_examined=$EXAMINED — the changed-file count cannot exceed the total, so the two contradict each other and neither is evidence of coverage"
fi
# The count above can also be wrong in the direction the comparison cannot see.
# review-broker.py CLAMPS files_examined down to files_supplied_total when the model
# claims more files than it was handed, and records that in examined_overcounted ("a
# count larger than what was supplied is not a bigger review, it is an unreliable
# self-report"). The clamped value is therefore >= the changed-file count by
# construction, the check above passes, and a PASS goes out on a number the broker had
# just declared untrustworthy — a model that hallucinates reading fifty files when given
# ten reads as full coverage. Codex [P1] on PR #49.
#
# Only a literal false clears it: absent or unparseable means this client cannot tell
# whether the number was clamped, and cannot-tell is UNKNOWN. Gated on a merge-eligible
# verdict only, for the same reason the check above is — a partial concerns/fail already
# stops at forge-pr, and killing it here would cost the human its findings.
OVERCOUNTED=$(jq -r '.examined_overcounted' "$V")
case "$OVERCOUNTED" in
  false) : ;;
  # REPORTED, not fatal — downgraded once files_examined_changed existed. When this
  # guard was written the AGGREGATE count was the only coverage signal there was, so a
  # clamped overcount destroyed the evidence entirely and refusing was right. It is no
  # longer the only signal: the changed-scoped count below is checked separately and
  # carries its own overcount flag, which stays fatal. What is left here is a model that
  # cannot count, and the clamp already bounds its claim to the true supplied total —
  # the error direction is "read MORE than I was given", never less.
  #
  # Measured before downgrading: 14 of 613 cached verdicts (2%) carry this flag, and the
  # cache key includes the request, so a PR that trips it stays blocked until someone
  # pushes an empty commit to force a re-judge. Hard-failing 2% of PRs on the model's
  # arithmetic, with recovery only by fabricating a commit, is not proportionate to a
  # signal that is now redundant. Live example: geekspace PR #23, blocked on
  # "examined 3/3" with the model claiming more.
  true)  echo "   NOTE: broker clamped an overcounted files_examined to $EXAMINED — the aggregate self-report is unusable; coverage rests on the changed-file count checked below" ;;
  # ABSENT stays fatal. That is schema drift between two processes with no shared
  # contract, not a model miscount, and it is the case where this client genuinely
  # cannot tell what it is looking at.
  # ABSENT stays fatal, but ONLY on a merge-eligible verdict. Rewriting this check as a
  # case dropped the "$VERDICT" = pass guard the previous `if` carried, which made schema
  # drift kill a concerns/fail run before section 6 could post its findings — discarding
  # actionable review output to prevent a merge that a non-pass verdict already prevents
  # at forge-pr. That is the same trade the two checks above refuse to make (Codex [P2]).
  *)
    if [ "$VERDICT" = "pass" ]; then
      die "broker did not report examined_overcounted (got '$OVERCOUNTED') — this gate cannot confirm $EXAMINED was not a clamped overcount, and an unconfirmable count is UNKNOWN, not a pass"
    fi
    echo "   NOTE: broker did not report examined_overcounted (got '$OVERCOUNTED') — coverage is unconfirmable, but the '$VERDICT' verdict already blocks the merge, so the findings are posted rather than discarded"
    ;;
esac
# The changed-file count is clamped by the same broker for the same reason, so it carries
# the same blind spot and needs the same flag. A model claiming it read 9 of 3 changed
# files is pinned to 3, which then clears the "read every changed file" check above on a
# number the broker had just declared unreliable. Written as a second block rather than
# folded into the one above: the two are independently reviewable, and the wording differs
# because the bound differs (supplied total vs changed-file count).
#
# Only a literal false clears it, for the reason given above — absent means this client
# cannot tell whether the number was clamped, and cannot-tell is UNKNOWN.
CHANGED_OVERCOUNTED=$(jq -r '.examined_changed_overcounted' "$V")
if [ "$VERDICT" = "pass" ] && [ "$CHANGED_OVERCOUNTED" != "false" ]; then
  if [ "$CHANGED_OVERCOUNTED" = "true" ]; then
    die "broker clamped an overcounted files_examined_changed to $EXAMINED_CHANGED — the model claimed to read more changed files than the PR contains, so the count is not evidence of coverage and a clean verdict on it is UNKNOWN, not a pass"
  fi
  die "broker did not report examined_changed_overcounted (got '$CHANGED_OVERCOUNTED') — this gate cannot confirm $EXAMINED_CHANGED was not a clamped overcount, and an unconfirmable count is UNKNOWN, not a pass"
fi
# An unread DEPENDENT is a real degradation, just not a failing one. Say so on the
# console rather than letting "$EXAMINED/$SUBMITTED" above pass for a full read; the
# same ratio is rendered into the posted comment, where forge-pr and a human both see it.
if [ "$EXAMINED" -lt "$SUBMITTED" ]; then
  echo "   NOTE: $(( SUBMITTED - EXAMINED )) of $SUBMITTED supplied file(s) went unread — the changed files were covered, some blast-radius context was not"
fi

# ---- 6. post it back --------------------------------------------------------------
# --argjson for the changed count so it renders as a bare number, not a quoted string.
# The "N/M supplied file(s) examined" segment must keep its exact wording and position:
# forge-pr parses it with VERDICT_META_RE, and a comment whose meta line stops matching
# makes forge-pr raise rather than merge. The changed-file segment is therefore appended
# AFTER it, never inserted before.
BODY=$(jq -r --arg sha "${HEAD_SHA:0:8}" --arg br "$BR_COUNT" --arg scanned "$BR_SCANNED" \
  --argjson changed "${#CHANGED[@]}" '
  "## 🤖 Local AI review — **" + (.verdict|ascii_upcase) + "**\n\n" +
  "`" + $sha + "` · model `" + .model + "` · " +
  (.files_examined|tostring) + "/" + (.files_supplied_total|tostring) + " supplied file(s) examined" +
  (if .examined_overcounted == true then " ⚠️ (clamped — unreliable)"
   elif .examined_overcounted != false then " ⚠️ (unconfirmed)"
   else "" end) + " · " +
  (.files_examined_changed|tostring) + "/" + ($changed|tostring) + " changed file(s) read · " +
  $br + " dependent(s) from " + $scanned + " scanned · " +
  (.standards_checked|tostring) + "/" + (.standards_supplied|tostring) + " project standards checked" +
  (if .cached then " · _cached verdict_" else "" end) + "\n\n" +
  # The console NOTE is ephemeral; THIS is the artifact a human and forge-pr actually
  # read. Without it the comment presents a clamped N/N as full coverage, and the
  # unread-context warning cannot fire either because the clamp made the numbers equal —
  # the durable record would state more than the gate knows (Codex [P2]).
  # Both untrustworthy shapes get the caveat, not just the clamp. An ABSENT flag reaches
  # this point only on a non-pass verdict (a PASS dies upstream), and that path continues
  # ON PURPOSE so the findings survive -- but continuing while the comment renders an
  # ordinary N/N would hand the reader a coverage claim nothing verified. Same principle
  # as the clamp case, same gap otherwise (Codex [P2]).
  (if .examined_overcounted == true then
     "> ⚠️ The model reported reading more files than it was supplied, so the broker " +
     "clamped the aggregate count above and it is **not** evidence of coverage. The " +
     "changed-file count beside it is validated separately and is what this verdict " +
     "rests on.\n\n"
   elif .examined_overcounted != false then
     "> ⚠️ The broker did not report whether the aggregate count above was clamped, so " +
     "this gate could not confirm it. The findings below stand; the coverage ratio does " +
     "not.\n\n"
   else "" end) +
  (if (.findings|length) == 0 then "No findings in the changed code or its blast radius.\n"
   else ((.findings | map(
     "### " + (if .severity=="critical" then "🔴" elif .severity=="major" then "🟠" else "🟡" end) +
     " " + .severity + " — " + .category + "\n" +
     "**" + .file + (if .line then ":" + (.line|tostring) else "" end) + "** — " + .summary + "\n\n" +
     .why + "\n") | join("\n"))) end) +
  "\n---\n_Advisory only — this gate does not block merges. Reviews the change and the " +
  "files that depend on it, not the whole project._"' "$V")

if [ "$POST" -eq 1 ]; then
  FHDR=$(mktemp); CMT=$(mktemp)
  trap 'rm -f "$REQ" "$DTMP" "$CJSON" "$V" "$BHDR" "$FHDR" "$CMT"' EXIT
  printf 'Authorization: token %s\n' "$FT" > "$FHDR"
  # The body goes through a file too. Not a credential, but a long review on argv is
  # an E2BIG waiting for the PR that finally exceeds the limit.
  jq -n --arg b "$BODY" '{body:$b}' > "$CMT"
  pc=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
       -H @"$FHDR" -H 'Content-Type: application/json' \
       --data-binary @"$CMT" \
       "$FORGE_API/repos/$REPO/issues/$PR/comments")
  [ "$pc" = "201" ] || die "could not post the review comment (HTTP $pc) — the review ran but nobody will see it"
  echo "   posted to $REPO PR #$PR"
else
  echo "$BODY"
fi

# Advisory: a real verdict, even "fail", is a successful RUN of the gate.
exit 0
