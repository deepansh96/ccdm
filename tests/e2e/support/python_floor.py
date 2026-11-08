#!/usr/bin/env python3
"""Python floor checks that vermin cannot make. Runs on the Mac's /usr/bin/python3.

  annotations <dir>  no *.py under <dir> may use an `X | Y` annotation unless it
                     has `from __future__ import annotations`
  imports <scripts>  every module under <scripts>/ccdmlib must import here

vermin's own union-types feature reports every bitwise `|`, such as
`os.O_RDWR | os.O_CREAT`, and ignores the future import, so it cannot do the first.
"""

import ast
import importlib
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def has_future_annotations(tree):
    return any(
        isinstance(node, ast.ImportFrom) and node.module == "__future__"
        and any(alias.name == "annotations" for alias in node.names)
        for node in tree.body
    )


def annotations_of(node):
    values = (getattr(node, field, None) for field in ("annotation", "returns"))
    return [value for value in values if isinstance(value, ast.AST)]


def is_union(annotation):
    return any(
        isinstance(inner, ast.BinOp) and isinstance(inner.op, ast.BitOr)
        for inner in ast.walk(annotation)
    )


def annotation_problems(root):
    problems = []
    for file in sorted(root.rglob("*.py")):
        try:
            tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
        except SyntaxError as error:
            version = ".".join(str(part) for part in sys.version_info[:2])
            problems.append(f"{file}:{error.lineno}: does not parse on Python {version}: {error.msg}")
            continue
        if has_future_annotations(tree):
            continue
        for node in ast.walk(tree):
            for annotation in annotations_of(node):
                if is_union(annotation):
                    problems.append(f"{file}:{annotation.lineno}: `X | Y` annotation without the future import")
    return problems


def import_problems(scripts):
    package = scripts / "ccdmlib"
    files = sorted(package.rglob("*.py"))
    if not files:
        return [f"{package}: no modules found"]
    sys.path.insert(0, str(scripts))
    problems = []
    for file in files:
        parts = list(file.relative_to(scripts).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts.pop()
        name = ".".join(parts)
        try:
            importlib.import_module(name)
        except Exception as error:  # Any failure at import time fails the floor.
            problems.append(f"{name}: {type(error).__name__}: {error}")
    return problems


def main(argv):
    if len(argv) != 3 or argv[1] not in ("annotations", "imports"):
        print("usage: python_floor.py annotations|imports <dir>", file=sys.stderr)
        return 2
    root = Path(argv[2]).resolve()
    problems = annotation_problems(root) if argv[1] == "annotations" else import_problems(root)
    for problem in problems:
        print(problem, file=sys.stderr)
    print(f"python floor {argv[1]}: {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
