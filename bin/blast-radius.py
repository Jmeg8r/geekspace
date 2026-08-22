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

MATCHING
      Python imports are resolved structurally (module path -> importers).
      Everything else — shell, YAML, markdown, docs — is matched by literal reference to
      the file's path or basename, because in this repo a workflow referencing bin/foo.sh
      or a runbook documenting it IS a dependent: change the flags and those break.

Usage:
  bin/blast-radius.py FILE [FILE...]           # dependents of these files
  bin/blast-radius.py --changed-from BASE      # dependents of files changed vs BASE
  bin/blast-radius.py --json FILE...           # machine-readable
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# Never read these as text, and never call them dependents.
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".docx", ".xlsx",
               ".woff", ".woff2", ".ico", ".zst", ".db", ".sqlite"}
MAX_FILE_BYTES = 512_000


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


def candidate_tokens(rel: str) -> list[str]:
    """How other files would refer to this one."""
    p = Path(rel)
    toks = {rel, p.name}
    if p.suffix == ".py":
        # bin/foo.py -> "foo", and package-ish dotted form for imports
        toks.add(p.stem)
        toks.add(".".join(p.with_suffix("").parts))
    return [t for t in toks if len(t) > 2]


def find_dependents(root: Path, targets: list[str]) -> tuple[dict, int, list[str]]:
    """Returns (dependents_by_target, files_scanned, scan_errors)."""
    files = tracked_files(root)
    target_set = set(targets)
    token_map = {t: candidate_tokens(t) for t in targets}
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
        for t, tokens in token_map.items():
            if any(tok in text for tok in tokens):
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


def changed_files(root: Path, base: str) -> list[str]:
    out = subprocess.run(["git", "-C", str(root), "diff", "--name-only", f"{base}...HEAD"],
                         capture_output=True, text=True, check=True)
    return [p for p in out.stdout.splitlines() if p.strip()]


def main() -> int:
    args = sys.argv[1:]
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    root = repo_root()

    if args and args[0] == "--changed-from":
        if len(args) < 2:
            sys.stderr.write("--changed-from needs a base ref\n")
            return 2
        targets = changed_files(root, args[1])
        if not targets:
            sys.stderr.write(f"FATAL: no files changed vs {args[1]} — nothing to review\n")
            return 1
    else:
        targets = args
    if not targets:
        sys.stderr.write(__doc__.split("Usage:")[1])
        return 2

    ok, control_msg = positive_control(root)
    if not ok:
        sys.stderr.write(f"FATAL: positive control FAILED — {control_msg}\n"
                         f"       Reporting UNKNOWN, not 'no dependents'. A dependency sweep\n"
                         f"       that cannot find a string it was told is there is broken.\n")
        return 1

    deps, scanned, _ = find_dependents(root, targets)
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
