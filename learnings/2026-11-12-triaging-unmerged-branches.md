# Triaging "unmerged" branches: most were done, one held a leak fix nobody shipped

**Problem.** `git branch --no-merged main` listed nine branches. Which were safe to delete,
and which held work that had never shipped?

## Approach

1. **For each branch, ask git whether its changes are already on main, not whether the
   branch was merged.** `git cherry main <branch>` marks a commit `-` when an equivalent patch
   is on main, and `+` when it isn't. Then compare the branch's files with main now:
   `git diff --stat main <branch> -- $(git diff --name-only $(git merge-base main <branch>) <branch>)`.
   A diff that only *removes* lines main has gained since means the branch is just old.
2. **Get the forge's PR history for each branch head.** `forge-pr` has no list command, so
   call the Forgejo API with the token from `~/.config/sovereign-forge/token`:
   `GET /api/v1/repos/<owner>/<repo>/pulls?state=all`, paged, matched on `head.ref`. Read
   the last non-bot comment of every closed PR that wasn't merged; it says why ("superseded
   by #83", "stale, branch kept").
3. **Sort each branch into one bucket:** merged (`merged: true`), superseded (closed, with the
   replacement named), a local-only equivalent (main has the same files or config), or
   **never pushed with no PR**. Check the last bucket hardest.
4. **For a never-pushed branch, prove whether main still has the bug.** Read the branch's
   intent, then look at the same lines on main. Here, `electron/functionSync.mjs` on main still
   logged the whole schema-failure error, user documents included. The branch was the fix.
5. **Delete safely.** First save `name sha` for every branch to `.git/deleted-*.txt`. Then
   delete by exact name with `git branch -d` (git itself refuses an unmerged branch), in a
   `bash <<'EOF'` loop that reads names from that file.
6. **Review from a clean tree.** `gstack-codex-review-prompt <base>` puts untracked files in
   the diff. If `git status` shows any, run the review from `git worktree add <path> <branch>`.
   Serena may create `.serena/` inside the worktree; delete it before `git worktree remove`.

## Judgment calls

- **Did not trust "not merged".** Squash merges leave branches that look unmerged forever.
  Patch-ids and PR state decide, not branch ancestry.
- **Did not delete the unpushed branch with the others.** Rebasing and shipping it took 20
  minutes; it would have been lost with the batch.
- **Did not use `git branch -D` on a list built in zsh.** zsh doesn't word-split `$VAR`, so
  the delete ran once with all names as one string and failed (lessons L55), after the forge
  deletes had already succeeded. Tip SHAs were saved first, so nothing was at risk.
- **Did not narrow the Codex scope by hand** with `--commit`. A clean worktree keeps the
  normal whole-branch scope and only removes the local noise.

## Rule

Before deleting a branch, ask "are its changes on main?" (patch-ids plus PR state), never
"was it merged?". The branch that fails both checks is the one to read.
