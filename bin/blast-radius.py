#!/usr/bin/env python3
"""
WHAT: Given the files a PR changed, find the files that DEPEND on them.
WHY:  The gate reviews "what did this change break", not "what is wrong with the repo".
      That requires the change plus its dependents — the blast radius. Reviewing the diff
      alone misses broken callers; reviewing the whole project is infeasible (astgl-articles
      is 372,600 lines) and turns the gate into noise that gets clicked through.

THE FAILURE MODE THIS GUARDS AGAINST
      A dependency sweep that finds nothing looks exactly like a change with no dependents.
      Both print "0 dependents" and both let the PR sail through. So this tool refuses to
      report a clean result it cannot justify: it runs a POSITIVE CONTROL first — a search
      for a token it has already proven exists in the tree — and if that control does not
      come back, it reports UNKNOWN and exits non-zero instead of "no dependents".
      Every run states how many files it scanned.

A NOTE ON THE EXAMPLE PATHS BELOW
      Every illustrative filename below carries an angle-bracketed segment --
      `<dir>/<name>.ts`, never a plausible real path. That is a rule about the whole
      class, not a patch on one example. This file deploys byte-identical into
      consuming repos and matches other files by LITERAL REFERENCE, so any path or
      basename spelled out here makes THIS file a permanent phantom dependent of the
      real file that happens to bear that name -- the same inflation the basename rule
      below exists to prevent, self-inflicted, shipped to every consumer.
      Spelling the examples out as full `src/`-rooted paths did exactly that to four
      real files in mcp-techkb. Shortening them by one leading segment only moved the
      problem to a repo laid out that way (Codex [P2] on PR #45) -- which is why the
      rule is a placeholder FORM and not a shorter path. No tracked file is named with
      angle brackets, so nothing in these examples can match one. This paragraph obeys
      its own rule: it describes those paths rather than spelling them.
      Measured, not asserted: a repo carrying one real file per basename-shaped token
      in this file produces zero phantoms for every plausible source name. Two matches
      survive and are deliberate. A file named exactly `.d.ts` hits the extension
      constants, which cannot be spelled any other way; and a SECOND file named like
      this one hits the usage block via the bare Python stem token, which the deployed
      copy never triggers because a file is excluded from its own dependents. Neither
      is a name a real tree carries.

MATCHING
      Python imports are resolved structurally (module path -> importers).
      JS/TS imports are resolved structurally too, and MUST be: under NodeNext an
      importer writes the COMPILED specifier for a SOURCE file — `from './<dir>/<name>.js'`
      names `<dir>/<name>.ts` — so the text never contains the path or basename of the
      file on disk, and literal matching reported ZERO dependents for a TypeScript
      change with eleven real importers (mcp-techkb, Codex [P1] on PR #13, 2026-08-29).
      A gate that cannot see any caller can issue a clean review of a breaking change,
      which is the exact failure this tool exists to prevent. Resolution is against the
      IMPORTER's own directory, not by rewriting the extension into another bare token:
      a sibling `'./<name>.js'` is only unambiguous once you know which directory it
      sits in — this repo's consumers have two same-named modules under one src/ tree.
      Everything else — shell, YAML, markdown, docs — is matched by literal reference to
      the file's path or basename, because in this repo a workflow referencing <dir>/<name>.sh
      or a runbook documenting it IS a dependent: change the flags and those break.
      The bare BASENAME counts only when it names exactly one file across the tracked
      tree plus the targets themselves: in a repo where every breaking-note archive
      ships the same handful of filenames, a file that merely names one of them is not
      referring to THIS one. Counting those matches inflated a 7-file PR to 42
      "dependents" / 411,912 request bytes — past the review broker's 400,000-byte cap
      (astgl-articles PR #58, 2026-08-27). The targets count too because a DELETED
      target no longer appears in git ls-files: judged against tracked files alone, a
      deleted, previously-unique basename read as count 0 and its dependents were
      silently missed — or handed to a surviving same-name file (Codex [P2] on that
      same PR's review). Path-qualified references always count, and Python import
      tokens are unchanged.

Usage:
  bin/blast-radius.py FILE [FILE...]           # dependents of these files
  bin/blast-radius.py --changed-from BASE      # dependents of files changed vs BASE
  bin/blast-radius.py --json FILE...           # machine-readable
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

# Never read these as text, and never call them dependents.
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".docx", ".xlsx",
               ".woff", ".woff2", ".ico", ".zst", ".db", ".sqlite"}
MAX_FILE_BYTES = 512_000

# Files whose relative import specifiers get resolved structurally. Everything not in
# this set stays on literal-reference matching.
JS_FAMILY_SUFFIX = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
# What an importer WRITES -> the source extensions NodeNext maps it onto. A table,
# not a blanket: the mapping is per-extension in BOTH directions. '.mjs' must reach a
# '.d.mts' declaration, and must NOT claim a same-stem '.ts' that TypeScript would
# never resolve it to — a false dependent is the same bug class as the bare-basename
# over-matching above. (Codex [P2] on sovereign-forge PR #44 caught the missing
# declaration extensions; the over-match was the other half of the same blanket.)
JS_SPEC_TO_SOURCE = {
    ".js":  (".ts", ".tsx", ".d.ts"),
    ".jsx": (".tsx", ".d.ts"),
    ".mjs": (".mts", ".d.mts"),
    ".cjs": (".cts", ".d.cts"),
}
# Source extensions reachable from an EXTENSIONLESS specifier (bundler/CJS resolution,
# where './foo' and './foo/index' are both legal). NodeNext requires the extension, so
# this branch never fires for it.
JS_SOURCE_EXT = (".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts",
                 ".js", ".jsx", ".mjs", ".cjs")
# Any quoted relative path, including backticks: `await import(`./<name>.js`)` is a
# static specifier like any other, and missing it means silently dropping a real
# caller -- the failure this resolver exists to prevent. The delimiter is captured and
# back-referenced so an opening quote only closes on its own kind. Deliberately not a
# JavaScript parser: this catches import/export/require/dynamic-import in one rule, and
# over-matching a relative path in an ordinary string literal is consistent with how
# this tool already treats a mere reference to a file as a dependency.
REL_SPEC_RE = re.compile(r"""(['"`])(\.\.?(?:/[^'"`\n]*)?)\1""")
# A template literal with an interpolation resolves to nothing at rest, so there is no
# path to check -- skip rather than invent one out of the literal `${...}` text.
INTERPOLATION = "${"


def repo_root() -> Path:
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True, check=True)
    return Path(out.stdout.strip())


def tracked_files(root: Path) -> list[Path]:
    out = subprocess.run(["git", "-C", str(root), "ls-files", "-z"],
                         capture_output=True, text=True, check=True)
    return [root / p for p in out.stdout.split("\0") if p]


def readable_text(p: Path) -> str | None:
    if p.suffix.lower() in SKIP_SUFFIX:
        return None
    try:
        if p.stat().st_size > MAX_FILE_BYTES:
            return None
        return p.read_text(encoding="utf-8", errors="strict")
    except (OSError, UnicodeDecodeError):
        return None  # binary or unreadable: not a text dependent


def candidate_tokens(rel: str, basename_counts: dict[str, int]) -> list[str]:
    """How other files would refer to this one.

    The bare basename is a usable reference only when it is unique among tracked
    files plus the targets themselves (see MATCHING above for the measured failure
    when it is not, and why deleted targets are part of the count).
    """
    p = Path(rel)
    toks = {rel}
    if basename_counts.get(p.name, 0) == 1:
        toks.add(p.name)
    if p.suffix == ".py":
        # <dir>/<name>.py -> "<name>", and package-ish dotted form for imports
        toks.add(p.stem)
        toks.add(".".join(p.with_suffix("").parts))
    return [t for t in toks if len(t) > 2]


def resolve_js_specifier(importer_rel: str, spec: str, known: set[str]) -> set[str]:
    """Repo-relative paths a relative JS/TS specifier could name.

    Resolution is against the IMPORTER's directory, which is the whole point: a bare
    basename token cannot tell `db/<name>.ts` from `ingest/<name>.ts` when each is
    imported from its own directory as the identical `'./<name>.js'`. Only the
    importer's location separates them. Returns candidates rather than picking one --
    the caller only asks whether a target is among them, so guessing Node's precedence
    order wrong cannot produce a wrong answer, only a slightly wider one.
    """
    joined = os.path.normpath(os.path.join(os.path.dirname(importer_rel), spec))
    if joined == "." or joined == ".." or joined.startswith(".." + os.sep):
        # Climbs out of the repo. Empty is the correct answer, not a swallowed
        # failure: every target comes from this repo's own diff, so it is always a
        # repo-relative path inside the root, and a specifier resolving outside can
        # never name one. The caller unions this into a set and asks `t in resolved`,
        # so it never depends on the result being non-empty.
        return set()
    out = {joined}
    stem, ext = os.path.splitext(joined)
    if ext in JS_SPEC_TO_SOURCE:
        # The NodeNext case: './<dir>/<name>.js' written for <dir>/<name>.ts.
        out.update(stem + e for e in JS_SPEC_TO_SOURCE[ext])
    elif joined not in known:
        # The specifier does not name a file that exists, so it can only be an
        # implied-extension or directory form -- expand it.
        #
        # This asks the TREE rather than guessing from the extension, and that is the
        # point. Three rounds of review each found a different extension the guess got
        # wrong in a different direction: './<name>.json' must not invent
        # '<name>.json.ts'; './<name>.test' must still reach <name>.test.ts; and
        # './<name>.css' must still reach a bundler's <name>.css.ts. No list of
        # extensions can settle those, because the extension is not what distinguishes
        # them -- whether the named file exists is. An existing file terminates the
        # specifier; a missing one means the extension was implied.
        out.update(joined + e for e in JS_SOURCE_EXT)
        out.update(f"{joined}/index{e}" for e in JS_SOURCE_EXT)
    return out


def find_dependents(root: Path, targets: list[str],
                    rename_pairs: list[tuple[str, str]] | None = None
                    ) -> tuple[dict, int, list[str]]:
    """Returns (dependents_by_target, files_scanned, scan_errors)."""
    files = tracked_files(root)
    basename_counts = Counter(f.name for f in files)
    target_set = set(targets)
    # A DELETED target is absent from ls-files, so its basename would read count 0
    # and the bare-basename token would silently never fire. Counting the target
    # itself restores the right reading: a previously-unique deleted basename is 1
    # (still matches); one shadowed by a surviving same-name file is 2 (ambiguous,
    # dropped — the mention may well mean the survivor).
    tracked_rels = {str(f.relative_to(root)) for f in files}
    # ...but a RENAME's two halves are ONE file, so the pair must contribute ONE count.
    # A directory-only move (old/x.sh -> new/x.sh) otherwise counts "x.sh" twice — once
    # tracked at the destination, once for the untracked source — which reads as
    # ambiguous and drops the bare-basename token for BOTH halves, so a caller saying
    # only "x.sh" vanishes from the blast radius entirely. Measured on a fixture: the
    # dependent set went from {new/x.sh: [uses.md]} to {} (Codex [P2], 2026-08-29).
    # Deliberately narrow: only a real rename pair whose basename did NOT change and
    # whose destination is tracked. An unrelated delete-plus-modify that happens to
    # share a basename is still counted twice, which is the ambiguity it really is.
    same_identity = {src for src, dst in (rename_pairs or [])
                     if Path(src).name == Path(dst).name and dst in tracked_rels}
    for t in target_set - tracked_rels:
        if t in same_identity:
            continue
        basename_counts[Path(t).name] += 1
    # Tracked files plus the targets: a DELETED target is absent from ls-files, and a
    # specifier naming it should still terminate rather than expand into inventions.
    known_paths = tracked_rels | target_set
    token_map = {t: candidate_tokens(t, basename_counts) for t in targets}
    deps: dict[str, set] = {t: set() for t in targets}
    scanned, errors = 0, []

    for f in files:
        rel = str(f.relative_to(root))
        if rel in target_set:
            continue  # a file is not its own dependent
        text = readable_text(f)
        if text is None:
            continue
        scanned += 1
        # Resolved once per FILE, not once per target: the specifiers a file contains
        # do not depend on which target is being asked about.
        resolved: set[str] = set()
        if f.suffix.lower() in JS_FAMILY_SUFFIX:
            for _quote, spec in REL_SPEC_RE.findall(text):
                if INTERPOLATION in spec:
                    continue
                resolved |= resolve_js_specifier(rel, spec, known_paths)
        for t, tokens in token_map.items():
            if t in resolved or any(tok in text for tok in tokens):
                deps[t].add(rel)
    return deps, scanned, errors


def positive_control(root: Path) -> tuple[bool, str]:
    """Prove the scan can actually find things before trusting an empty result.

    Picks a string this tool has independently confirmed is present — the repo's own
    .gitignore content — and searches for it the same way the real sweep does. If the
    control fails, the sweep is broken, not the repo.
    """
    gi = root / ".gitignore"
    if not gi.is_file():
        return False, "no .gitignore to use as a control"
    # Prefer the LONGEST entry: a short generic token like "data" would still match in a
    # sweep that was half-broken, which is exactly what a control must not do.
    entries = [ln.strip().rstrip("/") for ln in gi.read_text().splitlines()
               if ln.strip() and not ln.strip().startswith("#")]
    needle = max(entries, key=len) if entries else None
    if needle and len(needle) < 4:
        needle = None
    if not needle:
        return False, ".gitignore has no usable control token"

    hits = 0
    for f in tracked_files(root):
        text = readable_text(f)
        if text and needle in text:
            hits += 1
    if hits == 0:
        return False, f"control token {needle!r} found in 0 files — the sweep cannot see the tree"
    return True, f"control {needle!r} found in {hits} file(s)"


def changed_files(root: Path, base: str) -> tuple[list[str], list[tuple[str, str]]]:
    """Every path the change touches, BOTH halves of a rename included.

    Returns (paths, rename_pairs). The pairs are returned rather than discarded because
    the two halves of a rename are ONE file, and find_dependents needs to know that to
    count its basename once — see the same-identity note there.

    NOT --name-only: for a detected rename it prints only the destination, so the
    dependent sweep never looks for callers of the OLD path and a rename that breaks
    every importer resolves to zero dependents (mcp-techkb PR #13's R100 of
    .github/workflows/secret-scan.yml, Codex [P1] 2026-08-29). The old path is exactly
    the one whose dependents are now broken, so dropping it inverts the tool's purpose.

    -z because the fields are NUL-delimited: paths may contain spaces or newlines, and
    --name-status without -z would also C-quote non-ASCII names into paths that match
    nothing on disk.

    -M -C -l0 because detection must not depend on the consuming repo's git config. Under
    diff.renames=false a move emits separate D/A records, rename_pairs comes back empty,
    and the same-identity fix below silently stops working — a directory-only move then
    counts its basename twice and drops the token, losing exactly the dependents this
    function exists to find (Codex [P2], 2026-08-29). Each flag closes a different way
    the config can turn detection off, all three measured on git 2.50.1:

      -M   forces rename detection under diff.renames=false, which otherwise emits D/A.
      -C   because -M ALONE overrides diff.renames=copies and turns a detected copy back
           into a plain addition, quietly disabling the C handling in review-pr.sh.
      -l0  because diff.renameLimit caps the exhaustive pass: at renameLimit=1 a fixture
           of four moved-and-edited files dropped from 4 R records to 0 even WITH -M -C.
           -l0 is unlimited and restored all four.

    -l0 covers INEXACT renames specifically — a file moved AND edited. An exact rename is
    paired in a cheap pre-pass that no limit touches, so the R100 case that motivated all
    of this was never at risk; "moved it and tweaked it" is, and is the more common shape.
    git warns on stderr when it skips the pass, but this call captures stderr and drops
    it, so the degradation would have been silent.
    """
    out = subprocess.run(["git", "-C", str(root), "diff", "--name-status", "-z",
                          "-M", "-C", "-l0", f"{base}...HEAD"],
                         capture_output=True, text=True, check=True)
    fields = out.stdout.split("\0")
    paths: list[str] = []
    renames: list[tuple[str, str]] = []
    i = 0
    while i < len(fields):
        status = fields[i]
        if not status.strip():
            i += 1
            continue
        # R/C carry <status>\0<source>\0<destination>; everything else one path.
        want = 2 if status[0] in ("R", "C") else 1
        got = [p for p in fields[i + 1:i + 1 + want] if p.strip()]
        if len(got) < want:
            raise SystemExit(
                f"FATAL: git diff --name-status ended mid-record after {status!r} — "
                "refusing to scan a truncated file list"
            )
        if status[0] == "R":
            renames.append((got[0], got[1]))
            paths.extend(got)
        elif status[0] == "C":
            # A COPY does not change its source: the file is still there, still saying
            # what it said. Only the destination is new, so only the destination is part
            # of this change. Treating the source as changed would scan a file nothing
            # happened to and, in review-pr.sh, submit an empty diff the model would
            # still count as examined (Codex [P2], 2026-08-29).
            paths.append(got[1])
        else:
            paths.extend(got)
        i += 1 + want
    # dict.fromkeys dedupes while holding git's order (a path can appear twice when a
    # rename's destination is itself the source of another entry).
    return list(dict.fromkeys(paths)), renames


def main() -> int:
    args = sys.argv[1:]
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    root = repo_root()

    if args and args[0] == "--changed-from":
        if len(args) < 2:
            sys.stderr.write("--changed-from needs a base ref\n")
            return 2
        targets, rename_pairs = changed_files(root, args[1])
        if not targets:
            sys.stderr.write(f"FATAL: no files changed vs {args[1]} — nothing to review\n")
            return 1
    else:
        targets, rename_pairs = args, []
    if not targets:
        sys.stderr.write(__doc__.split("Usage:")[1])
        return 2

    ok, control_msg = positive_control(root)
    if not ok:
        sys.stderr.write(f"FATAL: positive control FAILED — {control_msg}\n"
                         f"       Reporting UNKNOWN, not 'no dependents'. A dependency sweep\n"
                         f"       that cannot find a string it was told is there is broken.\n")
        return 1

    deps, scanned, _ = find_dependents(root, targets, rename_pairs)
    # The control proves the tree is READABLE; this proves the sweep actually WALKED it.
    # Those are different claims, and only checking the first leaves a path where the
    # control passes while zero files were examined. Prompted by the gate reviewing its
    # own diff — its stated reasoning was wrong, but the asymmetry it pointed at was real.
    if scanned == 0:
        sys.stderr.write("FATAL: control passed but the sweep scanned 0 files — UNKNOWN, "
                         "not 'no dependents'.\n")
        return 1
    total = sorted({d for s in deps.values() for d in s})

    if as_json:
        print(json.dumps({
            "targets": targets, "files_scanned": scanned,
            "control": control_msg,
            "dependents": {t: sorted(v) for t, v in deps.items()},
            "blast_radius": total,
        }, indent=2))
    else:
        print(f"control: {control_msg}")
        for t in targets:
            d = sorted(deps[t])
            print(f"\n{t} — {len(d)} dependent(s)")
            for x in d:
                print(f"    {x}")
        print(f"\n── scanned {scanned} text file(s); blast radius {len(total)} unique file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
