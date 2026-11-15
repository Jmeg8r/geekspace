# WHAT: The AI gate's PR comment template. bin/review-pr.sh section 6 runs it with
#       jq -r -f against the broker's verdict JSON and posts what it prints.
# WHY:  A gate-kit file of its own (docs/changes/2026-11-13-review-pr-headroom) so
#       review-pr.sh stays installable under its own DIFF_CAP. It deploys byte-identical
#       like the rest of the kit, and forge-pr parses its output (CLAUDE.md section 3):
#       change this template and forge_pr.py together.
# Every $name is bound by the call in review-pr.sh section 6; jq refuses an unbound one
# at compile time, so the two cannot drift silently.
#
# The "N/M supplied file(s) examined" segment must keep its exact wording and position:
# forge-pr parses it with VERDICT_META_RE, and a comment whose meta line stops matching
# makes forge-pr raise rather than merge. The changed-file segment is therefore appended
# AFTER it, never inserted before.
#
# The zero-findings sentence is coverage-aware, and the coverage note renders on every
# verdict, reporting the two ratios as given and deriving nothing. It is a blockquote, so
# forge-pr's FINDING_RE never counts it. Why: sovereign-forge docs/review-pr-rationale.md#coverage-note.
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
  (if ((.initial_missing_changed_paths|type) == "array") and (.initial_missing_changed_paths|length) > 0 then
    "> **Coverage completion** — the first review skipped " +
    (.initial_missing_changed_paths|length|tostring) + " changed file(s); a second broker review of only those credited " +
    (((.coverage_completion.examined_changed_paths // [])|length)|tostring) +
    (if (.coverage_fallback|type) == "object" and .coverage_fallback.error != null then
       ", and a third, of what that left and without the already-reviewed diffs, " +
       "failed and credited nothing. Findings from the first two are below, and the " +
       "counts above are what they covered together.\n\n"
     elif (.coverage_fallback|type) == "object" then
       ", and a third, of what that left and without the already-reviewed diffs, credited " +
       (((.coverage_fallback.examined_changed_paths // [])|length)|tostring) +
       ". Findings from all three are below, and the counts above are what they covered together.\n\n"
     else
       ". Findings from both are below, and the counts above are what the two reviews covered together.\n\n"
     end)
   else "" end) +
  # Placed AFTER the metadata line terminates, not inside it. Injected mid-line it landed
  # between "supplied file(s) examined · " and the changed-file ratio, splitting the
  # metadata in half and putting the "> " marker somewhere other than the start of a
  # line, where Forgejo renders it as literal text rather than a blockquote (Codex [P2]
  # on PR #71, fourth round). Disclosed on EVERY verdict: the $skipped term further down
  # guards only the "no findings ... or its blast radius" sentence, which a verdict with
  # findings never reaches.
   (if $skipped > 0 then
      "> ⚠️ " + ($skipped|tostring) + " dependent(s) were refused as non-regular or " +
      "unreadable and never sent to the model, so this blast radius is **incomplete**. " +
      "The changed files are unaffected.\n\n"
    else "" end) +
  # Files the RESOLVER could not search, one step upstream of the refusal above: they
  # were never candidates, so no dependent count reflects them. Same placement and same
  # every-verdict rule. Unknown (-1) gets its own wording rather than a made-up number.
   (if $unreadable > 0 then
      "> ⚠️ " + ($unreadable|tostring) + " tracked file(s) could not be read by the " +
      "blast-radius resolver (over its size limit or not text) and were never searched " +
      "for references to this change, so this blast radius is **incomplete**. The " +
      "changed files are unaffected.\n\n"
    elif $unreadable < 0 then
      "> ⚠️ The blast-radius resolver did not report which files it could not read, so " +
      "this blast radius is **unverified**. The changed files are unaffected.\n\n"
    else "" end) +
  # Viewers the resolver set aside for their searched source (section 2). An ℹ️ and not
  # a ⚠️: the sweep is complete, this is what "complete" was measured over. The wording
  # covers BOTH ways a source can stand in -- searched, or itself a changed file, which
  # no sweep searches -- because claiming "searched" for the second would be false. Same
  # placement and every-verdict rule as the caveats above, and a blockquote throughout,
  # so forge-pr (header, metadata and "### " finding lines only) reads the comment as
  # before. $brgen was shape-checked in section 2: no newline or backtick can be in it.
   (if $brgencount > 0 then
      "> ℹ️ " + ($brgencount|tostring) + " generated diagram viewer(s) were not searched by " +
      "the blast-radius resolver; the source each is compiled from was searched instead, " +
      "or is itself one of the changed files under review:\n" +
      ($brgen | split("\n") | map(select(. != "")) | map("> " + .) | join("\n")) + "\n\n"
    else "" end) +
  # Alias configs assumed to set no paths or baseUrl (section 2). An ℹ️ like the line
  # above: a NOTE, so the all-clear stands. $bralias was neutralized in section 2.
   (if $braliascount > 0 then
      "> ℹ️ " + ($braliascount|tostring) + " alias config(s) could not be read by the " +
      "blast-radius resolver by design and were assumed to set no `paths` or `baseUrl`, " +
      "so imports through aliases they define were not matched:\n" +
      ($bralias | split("\n") | map(select(. != "")) | map("> " + .) | join("\n")) + "\n\n"
    else "" end) +
  # The two cuts made by the context budget, disclosed beside the refusal above and for the same
  # reason: files_examined counts what was SENT, so neither cut can show up as a
  # shortfall in the ratio. Blockquote below the metadata line, so forge-pr (header,
  # metadata and "### " finding lines only) reads the comment exactly as before.
   (if ($truncated > 0) or ($omitted > 0) then
      "> ⚠️ Context budget: " +
      ([ (if $truncated > 0 then ($truncated|tostring) + " dependent(s) were sent " +
            "truncated to their first " + ($ctxcap|tostring) + " bytes" else empty end),
         (if $omitted > 0 then ($omitted|tostring) + " dependent(s) were omitted by " +
            "the context-file limit and never sent" else empty end) ] | join("; ")) +
      ". This blast radius is **partial**. The changed files are unaffected.\n\n"
    else "" end) +
  # The docs-only exceptions, disclosed where the reader looks. Both are on the record in
  # the verdict (files_examined_reported, files_examined_source); this puts them in the
  # comment, so the pass on a docs PR never reads as a rule check that did not happen.
   (if .files_examined_source == "follow-up" then
      # The count the model gave, not a fixed 0: since the broker count-ordering fix it
      # also takes the follow-up over a nonzero undercount (claude-config #112: 2 of 19).
      "> ℹ️ Docs-only: the review turn reported files_examined=" +
      (if (.files_examined_reported|type) == "number" then (.files_examined_reported|tostring)
       else "(not recorded)" end) +
      ", below the changed files its follow-up named, a misreading of that field on prose, " +
      "so the examined count above comes from its follow-up answer, which named every " +
      "changed file as read" +
      # From the evidence in the verdict, on EVERY verdict: DELETED_UNREAD is computed for a
      # PASS only, and the broker tie-break also yields concerns/fail with unread deletions
      # (Codex [P2] on #142). The broker takes the tie-break only when every one is a deletion.
      # The FIRST follow-up is what this sentence describes, so a completion that later
      # credited a deletion must not erase it from the list (Codex [P2] on #142, round 3).
      ((if (.initial_missing_changed_paths|type) == "array" then .initial_missing_changed_paths
        else .missing_changed_paths end) as $unnamed
       | if ($unnamed|type) == "array" and ($unnamed|length) > 0
         then " except the pure deletion(s) " + ($unnamed | map("`" + tostring + "`") | join(", "))
         else "" end) +
      (if (.coverage_completion|type) == "object"
       then ", plus what the coverage completion below credited" else "" end) + ".\n\n"
    else "" end) +
  # Only reachable once section 5 has proved every path below is a pure deletion.
   (if $deletedunread > 0 then
      "> ℹ️ Deleted files: the model did not name " + ($deletedunread|tostring) +
      " pure deletion(s) as read: " +
      (.missing_changed_paths | map("`" + . + "`") | join(", ")) + ". Their deletion " +
      "diffs were sent and nothing of them remains to review; the blast-radius scan still " +
      "searched for references to them. Accepted because every unread changed file is a " +
      "deletion.\n\n"
    else "" end) +
   (if $binaryunread > 0 then
      "> ℹ️ Binary files: the model did not name " + ($binaryunread|tostring) +
      " binary file(s) as read: " +
      (.missing_changed_paths | map("`" + . + "`") | join(", ")) + ". git sent only a " +
      "stub for each: this pass says nothing about their content. Accepted because every " +
      "unread changed file is binary.\n\n"
    else "" end) +
   (if $stdzerodocs == 1 then
      "> ℹ️ Docs-only: **no project standard was applied**. This PR changes only " +
      "documentation, and the model judged none of the " +
      (.standards_supplied|tostring) + " standards applicable. This pass means the " +
      "text was read and nothing was flagged. It is not a rule check.\n\n"
    else "" end) +
   # Constant text apart from one integer: nothing from the repository is rendered here.
   (if $stdzerodeps == 1 then
      "> ℹ️ Dependencies only: **no project standard was applied**. This PR changes only " +
      "dependency declarations in `package.json`, and the model judged none of the " +
      (.standards_supplied|tostring) + " standards applicable. This pass means the " +
      "manifest diff was read and nothing was flagged. It is not a rule check, and it " +
      "does not judge whether the new versions are safe. That takes a dependency audit " +
      "and an image scan, which this review is not.\n\n"
    else "" end) +
   (if $stdzeroledger == 1 then
      "> ℹ️ Ledger data only: **no project standard was applied**. Every changed file is a " +
      "declared ledger sent as a digest, and the model judged none of the " +
      (.standards_supplied|tostring) + " standards applicable. This pass means the digest " +
      "was read and nothing was flagged. It does not check referential integrity or how IDs " +
      "are derived: that belongs in this repository\u0027s own CI.\n\n"
    else "" end) +
   (if $stdzerona == 1 then $stdna else "" end) +
   (if $stdapplied == 1 then $stdna else "" end) +
   # Low standards coverage on a code PR (section 5 decides; this only renders). EVERY
   # line opens with "> ": the forge-pr header, metadata and finding patterns all anchor at
   # line start on something else, and a label is single-line, so no rule text can forge
   # one of them. Ends on a blank line like its neighbours, so removing the block leaves
   # the comment byte-identical to an unflagged one (selftest 16g).
   (if $stdlow == 1 then
      "> ⚠️ **Low standards coverage** — the model named " + ($stdlowchecked|tostring) +
      " of " + ($stdlowsupplied|tostring) + " project standards as checked. This pass " +
      "does not cover the rest. " +
      (if ($stdunchecked|type) == "object" then
         "It did not name these:\n>\n" +
         ($stdunchecked.labels | map("> > - " + .) | join("\n")) +
         (if $stdunchecked.total > ($stdunchecked.labels|length) then
            "\n> > - …and " + (($stdunchecked.total - ($stdunchecked.labels|length))|tostring) +
            " more, not listed here"
          else "" end) + "\n\n"
       else "The list of standards it did not name was not available.\n\n" end)
    else "" end) +
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
  # The blast-radius claim also drops when the aggregate count is UNTRUSTWORTHY, not only
  # when it is short, and this term is LIVE rather than defensive. A clamped count is no
  # longer fatal on a PASS -- section 5 downgraded it to a console NOTE and continues --
  # so "pass, zero findings, examined_overcounted=true" now reaches this template, with
  # examined == supplied because the clamp made them equal. Both shortfall terms are
  # therefore false, and without this one the sentence would claim a clean blast radius
  # directly beneath the caveat above saying that same count is not evidence of coverage.
  # Merging the two warnings without it reintroduces the overclaim both exist to remove,
  # on a third axis. `!= false` is the allowlist the guards upstream use: absent is
  # untrustworthy, not trustworthy (absent is still fatal on a PASS, so only `true`
  # reaches here with zero findings -- the broker maps zero findings to `pass`).
  (if (.findings|map(select(.unmatched_file|not))|length) == 0 then
     (if (.files_examined < .files_supplied_total)
         or (.files_examined_changed < $changed)
         or (.examined_overcounted != false)
         or ($skipped > 0)
         or ($truncated > 0)
         or ($omitted > 0)
         or ($unreadable != 0)
      then "No findings in the changed code.\n"
      else "No findings in the changed code or its blast radius.\n" end)
   else ((.findings|map(select(.unmatched_file|not)) | map(
     "### " + (if .severity=="critical" then "🔴" elif .severity=="major" then "🟠" else "🟡" end) +
     " " + .severity + " — " + .category + "\n" +
     "**" + .file + (if .line then ":" + (.line|tostring) else "" end) + "** — " + .summary + "\n\n" +
     .why + "\n") | join("\n"))) end) +
  ($um|if .=="" then . else .+"\n" end)+
  (if (.files_examined < .files_supplied_total)
      or (.files_examined_changed < $changed) then
     "\n> ⚠ **Reduced coverage** — read " + (.files_examined|tostring) + " of " +
     (.files_supplied_total|tostring) + " supplied file(s), " +
     (.files_examined_changed|tostring) + " of " + ($changed|tostring) +
     " changed file(s). Findings above cover only what was read.\n"
   else "" end) +
  (if $generated == "" then "" else
     "\n> **Generated artifacts excluded from this review** — generated output (a compiled\n" +
     "> viewer or a lockfile) whose source IS under review in this PR. Listed so the coverage claim above is read\n" +
     "> correctly: these bytes were never sent to the model.\n>\n" +
     ($generated | split("\n") | map(select(. != "")) | map("> " + .) | join("\n")) + "\n"
   end) +
  (if $ledger == "" then "" else
     "\n> **Declared ledgers sent as a digest, not a raw diff**: edited and removed rows were\n" +
     "> shown in full. Appended rows were shown only as counts and per-field value tallies\n" +
     "> (a field with few distinct values lists them, shortened), never as rows.\n>\n" +
     ($ledger | split("\n") | map(select(. != "")) | map("> " + .) | join("\n")) + "\n"
   end) +
  "\n---\n_Advisory only — this gate does not block merges. Reviews the change and the " +
  "files that depend on it, not the whole project._"
