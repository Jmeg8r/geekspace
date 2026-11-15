#!/usr/bin/env python3
"""
WHAT: The gate's client-side verdict judges. review-pr.sh section 5 hands each one a
      broker verdict and acts only on what it accepts.
WHY:  A broker field is a model's claim relayed by a service. review-pr.sh re-judges the
      fields that relax a refusal or a warning (CLAUDE.md 4.4, 4.7, 4.8) and never trusts
      them as sent. The judges live in their own kit file because neither review-pr.sh nor
      blast-radius.py has room for them under the install cap that selftest-review-pr.sh
      case 19 enforces: each kit file must fit in the diff of the PR that installs it
      (docs/changes/2026-11-13-gate-judge-kit-file). This file deploys byte-identical
      into consumers like the other two.

Usage:
  bin/gate-judge.py --not-applicable VERDICT N < standards (a JSON array)
      judge and render a verdict's per-standard not-applicable reasons (4.7)
  bin/gate-judge.py --applicable-coverage VERDICT N CHECKED < standards (a JSON array)
      judge and render the excuses that replace the low-coverage flag (4.4)
  bin/gate-judge.py --unmatched VERDICT REQUEST
      re-judge and render findings that name no supplied file (4.8)
Exit: 0 accepted (the block on stdout), 1 refused (the reason on stderr), 2 bad usage.
"""

from __future__ import annotations

# IMPORT-PATH GUARD, before any shadowable import: the same guard as blast-radius.py, for
# the same reason. Running bin/gate-judge.py puts bin/ FIRST on sys.path, the gate job runs
# it with BROKER_TOKEN and a forge token in scope, and a PR that adds bin/json.py would
# otherwise have that module run inside this script. Suffix comparison, not equality: on
# macOS sys.path[0] is the resolved /private/var form while __file__ keeps /var.
import sys

_script_dir = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."
_p0 = sys.path[0] if sys.path else None
if _p0 is not None and (
    _p0 in ("", ".", _script_dir)
    or _p0.endswith(_script_dir)
    or _script_dir.endswith(_p0)
):
    sys.path.pop(0)
del _script_dir, _p0

import json
import unicodedata
from pathlib import Path

# review-pr.sh section 5's fourth zero-standards exception (CLAUDE.md section 4.7; geekspace
# forge PR #84, TOML and shell reviewed against rules about Electron and Convex), and the
# low-coverage excuses that reuse its rules (4.4).
# The bounds must match review-broker.py's NA_REASON_MIN_CHARS/MAX_CHARS by inspection.
NA_REASON_MIN_CHARS = 12
NA_REASON_MAX_CHARS = 300
# How many standards are NAMED in the comment, as review-pr.sh's STD_LABEL_CAP; the rest
# are counted. Each label keeps this many characters of the standard's text.
NA_LABEL_CAP = 200
NA_LABEL_CHARS = 100
# The broker's own problem text, quoted in a refusal, is cut to this many characters.
NA_BROKER_WHY_CHARS = 300
# Every control character and Unicode line separator becomes a space, so a label or reason
# stays one blockquote line and cannot forge a line forge-pr parses.
_NA_BREAKS = {c: " " for c in [*range(32), 127, 133, 0x2028, 0x2029]}


def _na_text(value: object) -> str:
    return str(value).translate(_NA_BREAKS)


def _is_count(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _visible(text: str) -> str:
    """`text` trimmed and without format characters (zero-width, bidi), which strip() keeps."""
    return "".join(c for c in text if unicodedata.category(c) != "Cf").strip()


def reasoned_rows_problem(rows: object, n: int, field: str) -> str | None:
    """Why `rows` is NOT a list of standards judged not applicable with a reason, or None:
    at least one row, each number in 1..n named once, `applies` exactly false, a reason of
    NA_REASON_MIN..MAX visible characters, and no reason shared by two standards once case
    and whitespace are folded: one sentence pasted onto every rule is not a judgement about
    any of them. The client's copy of the broker's rules: a broker field is never trusted."""
    if not isinstance(rows, list) or not rows:
        return f"the verdict carries no {field} list"
    seen: set = set()
    reasons: set = set()
    for row in rows:
        if not isinstance(row, dict):
            return "an entry is not an object"
        num, reason = row.get("standard"), row.get("reason")
        if not _is_count(num) or not 1 <= num <= n or num in seen:
            return f"standard number {num!r} is out of range or repeated"
        seen.add(num)
        if row.get("applies") is not False:
            return f"standard {num} is not marked as not applicable"
        if not isinstance(reason, str):
            return f"standard {num}: the reason is not text"
        text = _visible(reason)
        if not NA_REASON_MIN_CHARS <= len(text) <= NA_REASON_MAX_CHARS:
            return (
                f"standard {num}: a reason of {len(text)} character(s), expected "
                f"{NA_REASON_MIN_CHARS}..{NA_REASON_MAX_CHARS}"
            )
        folded = " ".join(text.casefold().split())
        if folded in reasons:
            return f"standard {num}: the same reason is given for another standard"
        reasons.add(folded)
    return None


def not_applicable_problem(rows: object, n: int) -> str | None:
    """reasoned_rows_problem, plus: the list must answer all n standards."""
    if isinstance(rows, list) and rows and (n <= 0 or len(rows) != n):
        return f"the list answers {len(rows)} standard(s) of {n}"
    return reasoned_rows_problem(rows, n, "standards_not_applicable")


def not_applicable_cli(args: list[str]) -> int:
    """--not-applicable VERDICT N, the standards this client sent on stdin as a JSON array.
    Exit 0 with the comment's blockquote on stdout when VERDICT's standards_not_applicable
    is acceptable; exit 1 with the reason on stderr when it is not; 2 on bad usage."""
    if len(args) != 2 or not args[1].isdigit():
        sys.stderr.write("--not-applicable needs VERDICT N, the standards on stdin\n")
        return 2
    n = int(args[1])
    try:
        standards = json.loads(sys.stdin.read())
        verdict = json.loads(Path(args[0]).read_text())
    except (OSError, ValueError) as e:
        sys.stderr.write(f"   not-applicable list: unreadable ({e})\n")
        return 1
    if (
        not isinstance(standards, list)
        or len(standards) != n
        or not isinstance(verdict, dict)
    ):
        sys.stderr.write(
            f"   not-applicable list: expected {n} standards and a verdict object\n"
        )
        return 1
    rows = verdict.get("standards_not_applicable")
    problem = not_applicable_problem(rows, n)
    if problem is not None:
        why = verdict.get("standards_applicability_problem")
        sys.stderr.write(
            f"   not-applicable list refused: {problem}"
            + (f" (broker: {_na_text(why)[:NA_BROKER_WHY_CHARS]})" if why else "")
            + "\n"
        )
        return 1
    labels = [
        f"> > - ({r['standard']}) {_na_text(standards[r['standard'] - 1])[:NA_LABEL_CHARS]}"
        f" → {_na_text(r['reason']).strip()}"
        for r in sorted(rows, key=lambda r: r["standard"])[:NA_LABEL_CAP]
    ]
    if n > NA_LABEL_CAP:
        labels.append(f"> > - …and {n - NA_LABEL_CAP} more, not listed here")
    sys.stdout.write(
        "> ℹ️ No standard applies: **no project standard was applied**. The model named "
        f"none of the {n} standards as checked, and when asked about each one it judged it "
        "not applicable to this change, for the reason given. This pass means the change "
        "was read and nothing was flagged. It is not a rule check: read the reasons.\n>\n"
        + "\n".join(labels)
        + "\n\n"
    )
    return 0


# Why: sovereign-forge docs/changes/2026-11-13-low-coverage-applicable/spec.md (R2).
def applicable_coverage_problem(verdict: object, n: int, checked: int) -> str | None:
    """Why VERDICT does NOT show each of `n` standards judged (exactly `checked` of them) or
    excused with a reason; None when it does. Anything short of that keeps the flag."""
    if not isinstance(verdict, dict):
        return "the verdict is not an object"
    excused = verdict.get("standards_excused")
    problem = reasoned_rows_problem(excused, n, "standards_excused")
    if problem is not None:
        return problem
    excused_nums = {r["standard"] for r in excused}
    judged = verdict.get("standards_verdicts")
    if not isinstance(judged, list) or not judged:
        return "the verdict carries no standards_verdicts list"
    judged_nums: set = set()
    for row in judged:
        num = row.get("standard") if isinstance(row, dict) else None
        if not _is_count(num) or not 1 <= num <= n or num in judged_nums:
            return f"judged standard number {num!r} is out of range or repeated"
        if num in excused_nums:
            return f"standard {num} is both judged and excused"
        if row.get("result") not in ("complies", "violates"):
            return f"judged standard {num}: the result is not complies or violates"
        if not all(
            isinstance(row.get(k), str) and _visible(row[k])
            for k in ("file", "evidence")
        ):
            return f"judged standard {num}: no changed file or no evidence"
        judged_nums.add(num)
    if len(judged_nums) != checked:
        return (
            f"{len(judged_nums)} standard(s) judged, but the verdict counts {checked}"
        )
    if len(judged_nums) + len(excused_nums) != n:
        return (
            f"{len(judged_nums)} judged and {len(excused_nums)} excused do not cover "
            f"all {n} standards"
        )
    return None


def applicable_coverage_cli(args: list[str]) -> int:
    """--applicable-coverage VERDICT N CHECKED, standards on stdin: exit 0 with the comment
    block on stdout, 1 with the reason on stderr, 2 on bad usage."""
    if len(args) != 3 or not args[1].isdigit() or not args[2].isdigit():
        sys.stderr.write(
            "--applicable-coverage needs VERDICT N CHECKED, the standards on stdin\n"
        )
        return 2
    n, checked = int(args[1]), int(args[2])
    try:
        standards = json.loads(sys.stdin.read())
        verdict = json.loads(Path(args[0]).read_text())
    except (OSError, ValueError) as e:
        sys.stderr.write(f"   applicable-coverage: unreadable ({e})\n")
        return 1
    if not isinstance(standards, list) or len(standards) != n:
        sys.stderr.write(f"   applicable-coverage: expected {n} standards\n")
        return 1
    problem = applicable_coverage_problem(verdict, n, checked)
    if problem is not None:
        why = (
            verdict.get("standards_excused_problem")
            if isinstance(verdict, dict)
            else None
        )
        sys.stderr.write(
            f"   applicable-coverage refused: {problem}"
            + (f" (broker: {_na_text(why)[:NA_BROKER_WHY_CHARS]})" if why else "")
            + "\n"
        )
        return 1
    rows = sorted(verdict["standards_excused"], key=lambda r: r["standard"])
    labels = [
        f"> > - ({r['standard']}) {_na_text(standards[r['standard'] - 1])[:NA_LABEL_CHARS]}"
        f" → {_na_text(r['reason']).strip()}"
        for r in rows[:NA_LABEL_CAP]
    ]
    if len(rows) > NA_LABEL_CAP:
        labels.append(f"> > - …and {len(rows) - NA_LABEL_CAP} more, not listed here")
    sys.stdout.write(
        f"> ℹ️ Applicable standards: {checked} of {n} project standards apply to this change, "
        "and the model gave a verdict on each one (complies or violates, the changed file, "
        f"and what shows it). It judged the other {len(rows)} not applicable, for the "
        "reason given. A standard listed here was not checked: read the reasons.\n>\n"
        + "\n".join(labels)
        + "\n\n"
    )
    return 0


def _json_type(v: object) -> str:
    """The value's JSON type, named as jq's `type` names it."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    return {str: "string", list: "array", dict: "object"}.get(type(v), type(v).__name__)


def _one_line(v: object) -> str:
    return (
        (v if isinstance(v, str) else json.dumps(v))
        .replace("\n", " ")
        .replace("`", "'")
    )


def unmatched_cli(args: list[str]) -> int:
    """--unmatched VERDICT REQUEST: the findings the broker marked `unmatched_file`, whose
    `file` is no changed or blast-radius path of REQUEST, are kept out of the verdict
    (CLAUDE.md section 4.8). Exit 0 with the comment's disclosure of them on stdout (empty
    when there are none); exit 1 when `findings` is not a list of objects, or when a mark
    sits on a path REQUEST did supply, because then the verdict left a real finding out and
    cannot be trusted; 2 on bad usage."""
    if len(args) != 2:
        sys.stderr.write("--unmatched needs VERDICT REQUEST\n")
        return 2
    try:
        verdict, req = (json.loads(Path(a).read_text()) for a in args)
        supplied = {
            str(f["path"])
            for key in ("changed", "context")
            for f in req.get(key) or []
            if isinstance(f, dict) and f.get("path")
        }
        findings = verdict.get("findings")
        # The gate's only check of the findings shape; review-pr.sh calls this before jq
        # counts them, because jq's length reads a missing or null findings as 0 and a
        # string as its character count (geekspace #102, comment 29377). Here, not in
        # review-pr.sh, because that script is at its own DIFF_CAP (selftest
        # "installability"). A non-object entry is refused too, never skipped.
        if "findings" not in verdict:
            problem = "findings absent"
        elif not isinstance(findings, list):
            problem = f"findings is {_json_type(findings)}"
        else:
            problem = next(
                (
                    f"findings has an entry of type {_json_type(f)}"
                    for f in findings
                    if not isinstance(f, dict)
                ),
                None,
            )
        if problem:
            sys.stderr.write(
                f"   broker verdict malformed: {problem}, expected a list of "
                "finding objects\n"
            )
            return 1
    except (OSError, ValueError, AttributeError) as e:
        sys.stderr.write(f"   unmatched findings: unreadable ({e})\n")
        return 1
    marked = [f for f in findings if f.get("unmatched_file") is True]
    wrong = sorted(
        {
            f["file"]
            for f in marked
            if isinstance(f.get("file"), str) and f["file"] in supplied
        }
    )
    if wrong:
        sys.stderr.write(
            f"   broker marked a finding on {', '.join(wrong)} as naming no "
            "supplied file, but this request supplied it: the verdict left it "
            "out, so it cannot be trusted\n"
        )
        return 1
    stale = sum(
        1
        for f in findings
        if f.get("unmatched_file") is not True
        and not (isinstance(f.get("file"), str) and f["file"] in supplied)
    )
    if stale:
        sys.stderr.write(
            f"   NOTE: {stale} finding(s) name no supplied file but are unmarked "
            "and counted: the broker predates CLAUDE.md 4.8\n"
        )
    if not marked:
        return 0
    sys.stderr.write(
        f"   unmatched findings: {len(marked)}, shown apart and not counted\n"
    )
    sys.stdout.write(
        f"\n> **Not counted toward the verdict**: {len(marked)} finding(s) name no file this "
        "review was given (neither a changed file nor a dependent), so they cannot describe "
        "what this change did. Shown so nothing the model said is hidden:\n>\n"
        + "\n".join(
            f"> - `{_one_line(f.get('file'))}` — {_one_line(f.get('severity'))} / "
            f"{_one_line(f.get('category'))}: {_one_line(f.get('summary'))}"
            for f in marked
        )
        + "\n"
    )
    return 0


MODES = {
    "--not-applicable": not_applicable_cli,
    "--applicable-coverage": applicable_coverage_cli,
    "--unmatched": unmatched_cli,
}


def main() -> int:
    args = sys.argv[1:]
    cli = MODES.get(args[0]) if args else None
    if cli is None:
        # Never fall through to anything else: an older resolver treated a mode it did not
        # know as paths to sweep and exited 0, which is why review-pr.sh checks headers.
        sys.stderr.write(__doc__.split("Usage:")[1])
        return 2
    return cli(args[1:])


if __name__ == "__main__":
    sys.exit(main())
