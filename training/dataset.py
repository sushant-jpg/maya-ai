"""Validate, deduplicate, and split Maya's curated supervised examples."""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

MAX_DATASET_BYTES = 100 * 1024 * 1024
MAX_LINE_BYTES = 1024 * 1024
MAX_MESSAGES = 128
MAX_CONTENT_CHARS = 32_000
SENSITIVE_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{16,}"),
    re.compile(r"(?i)\b(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*['\"]?[^\s'\"]{8,}"),
)
ALLOWED_ROLES = {"system", "user", "assistant"}


class DatasetValidationError(ValueError):
    """Raised when a dataset contains an invalid or unsafe example."""


def _validate_messages(value: Any, line_number: int) -> list[dict[str, str]]:
    prefix = f"line {line_number}: "
    if not isinstance(value, dict) or set(value) != {"messages"}:
        raise DatasetValidationError(prefix + 'expected exactly one "messages" field.')
    messages = value["messages"]
    if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
        raise DatasetValidationError(prefix + f"messages must contain 1 to {MAX_MESSAGES} entries.")

    normalized: list[dict[str, str]] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            raise DatasetValidationError(prefix + f"message {index + 1} must contain only role and content.")
        role = message["role"]
        content = message["content"]
        if role not in ALLOWED_ROLES:
            raise DatasetValidationError(prefix + f"message {index + 1} has an unsupported role.")
        if not isinstance(content, str) or not content.strip() or len(content) > MAX_CONTENT_CHARS:
            raise DatasetValidationError(prefix + f"message {index + 1} content must be non-empty and at most {MAX_CONTENT_CHARS} characters.")
        if role == "system" and index != 0:
            raise DatasetValidationError(prefix + "a system message is allowed only as the first entry.")
        if index == 0 and role not in {"system", "user"}:
            raise DatasetValidationError(prefix + "messages must start with a user message, optionally preceded by system.")
        if index > 0 and role != "system":
            expected = "assistant" if normalized[-1]["role"] == "user" else "user"
            if role != expected:
                raise DatasetValidationError(prefix + f"message {index + 1} must have role {expected}.")
        if any(pattern.search(content) for pattern in SENSITIVE_PATTERNS):
            raise DatasetValidationError(prefix + f"message {index + 1} appears to contain a credential or private key; remove it before curation.")
        normalized.append({"role": role, "content": content})

    if normalized[-1]["role"] != "assistant":
        raise DatasetValidationError(prefix + "each example must end with an assistant answer.")
    if not any(message["role"] == "user" for message in normalized):
        raise DatasetValidationError(prefix + "each example must include a user message.")
    return normalized


def load_dataset(path: Path) -> tuple[list[dict[str, list[dict[str, str]]]], list[str]]:
    if not path.is_file():
        raise DatasetValidationError(f"Dataset file does not exist: {path}")
    if path.stat().st_size > MAX_DATASET_BYTES:
        raise DatasetValidationError(f"Dataset exceeds the {MAX_DATASET_BYTES // (1024 * 1024)} MiB size limit.")

    examples: list[dict[str, list[dict[str, str]]]] = []
    errors: list[str] = []
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as dataset_file:
        for line_number, raw_line in enumerate(dataset_file, start=1):
            if not raw_line.strip():
                continue
            if len(raw_line.encode("utf-8")) > MAX_LINE_BYTES:
                errors.append(f"line {line_number}: exceeds the {MAX_LINE_BYTES // 1024} KiB per-example size limit.")
                continue
            try:
                parsed = json.loads(raw_line)
                messages = _validate_messages(parsed, line_number)
                canonical = json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                if canonical in seen:
                    errors.append(f"line {line_number}: duplicate example.")
                    continue
                seen.add(canonical)
                examples.append({"messages": messages})
            except (json.JSONDecodeError, DatasetValidationError) as error:
                errors.append(str(error))
    return examples, errors


def _write_new_file(path: Path, examples: list[dict[str, list[dict[str, str]]]]) -> None:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as output_file:
            temporary_path = Path(output_file.name)
            for example in examples:
                output_file.write(json.dumps(example, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.link(temporary_path, path)
    except FileExistsError as error:
        raise DatasetValidationError(f"Refusing to overwrite existing dataset output: {path}") from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def validate_command(args: argparse.Namespace) -> int:
    try:
        examples, errors = load_dataset(args.dataset)
    except (OSError, UnicodeError, DatasetValidationError) as error:
        print(f"Dataset validation failed: {error}", file=sys.stderr)
        return 2
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        print(f"Rejected dataset: {len(errors)} issue(s); {len(examples)} valid unique example(s) remain.", file=sys.stderr)
        return 1
    print(f"Dataset valid: {len(examples)} unique example(s).")
    return 0


def split_command(args: argparse.Namespace) -> int:
    try:
        examples, errors = load_dataset(args.dataset)
        if errors:
            raise DatasetValidationError(f"input has {len(errors)} validation issue(s); no split was written.")
        if len(examples) < 2:
            raise DatasetValidationError("at least two unique examples are required for a train/validation split.")
        output_dir = args.output_dir.resolve()
        train_path = output_dir / "train.jsonl"
        validation_path = output_dir / "validation.jsonl"
        if train_path.exists() or validation_path.exists():
            raise DatasetValidationError(f"Refusing to overwrite existing split files in {output_dir}.")
        output_dir.mkdir(parents=True, exist_ok=True)

        shuffled = list(examples)
        random.Random(args.seed).shuffle(shuffled)
        validation_count = max(1, round(len(shuffled) * args.validation_ratio))
        validation = shuffled[:validation_count]
        train = shuffled[validation_count:]
        _write_new_file(train_path, train)
        try:
            _write_new_file(validation_path, validation)
        except Exception:
            train_path.unlink(missing_ok=True)
            raise
        print(f"Wrote {len(train)} training and {len(validation)} validation examples to {output_dir}.")
        return 0
    except (OSError, UnicodeError, DatasetValidationError) as error:
        print(f"Dataset split failed: {error}", file=sys.stderr)
        return 2


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="validate a curated JSONL dataset")
    validate.add_argument("dataset", type=Path)
    validate.set_defaults(handler=validate_command)
    split = commands.add_parser("split", help="deduplicate and create deterministic train/validation JSONL files")
    split.add_argument("dataset", type=Path)
    split.add_argument("--output-dir", required=True, type=Path)
    split.add_argument("--validation-ratio", type=float, default=0.1)
    split.add_argument("--seed", type=int, default=42)
    split.set_defaults(handler=split_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = create_parser()
    args = parser.parse_args(argv)
    if args.command == "split" and not 0.05 <= args.validation_ratio <= 0.5:
        parser.error("--validation-ratio must be between 0.05 and 0.5")
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
