"""Unit tests for safe fine-tuning dataset preparation and preflight."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from training.dataset import load_dataset, main as dataset_main
from training.preflight import build_report


class DatasetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_jsonl(self, name: str, values: list[object]) -> Path:
        path = self.root / name
        path.write_text("".join(json.dumps(value) + "\n" for value in values), encoding="utf-8")
        return path

    def test_validates_and_deduplicates_messages_format(self) -> None:
        example = {"messages": [
            {"role": "user", "content": "Write a semantic login form."},
            {"role": "assistant", "content": "<form></form>"},
        ]}
        path = self.write_jsonl("examples.jsonl", [example, example])
        examples, errors = load_dataset(path)
        self.assertEqual(len(examples), 1)
        self.assertEqual(errors, ["line 2: duplicate example."])

    def test_rejects_malformed_roles_and_credentials_without_echoing_content(self) -> None:
        invalid_role = {"messages": [{"role": "tool", "content": "not allowed"}]}
        credential = {"messages": [
            {"role": "user", "content": "Use this token"},
            {"role": "assistant", "content": "api_key=supersecretvalue123"},
        ]}
        path = self.write_jsonl("unsafe.jsonl", [invalid_role, credential])
        examples, errors = load_dataset(path)
        self.assertEqual(examples, [])
        self.assertEqual(len(errors), 2)
        self.assertNotIn("supersecretvalue123", "\n".join(errors))

    def test_split_is_deterministic_and_refuses_to_overwrite(self) -> None:
        values = [
            {"messages": [{"role": "user", "content": f"Question {index}"}, {"role": "assistant", "content": f"Answer {index}"}]}
            for index in range(10)
        ]
        dataset = self.write_jsonl("curated.jsonl", values)
        output_dir = self.root / "split"
        self.assertEqual(dataset_main(["split", str(dataset), "--output-dir", str(output_dir), "--seed", "7"]), 0)
        first_train = (output_dir / "train.jsonl").read_text(encoding="utf-8")
        self.assertEqual(dataset_main(["split", str(dataset), "--output-dir", str(output_dir), "--seed", "7"]), 2)
        self.assertEqual(first_train, (output_dir / "train.jsonl").read_text(encoding="utf-8"))
        train = [json.loads(line) for line in first_train.splitlines()]
        validation = [json.loads(line) for line in (output_dir / "validation.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(train), 9)
        self.assertEqual(len(validation), 1)
        self.assertTrue(set(map(str, train)).isdisjoint(set(map(str, validation))))

    def test_preflight_is_read_only_and_rejects_missing_local_model(self) -> None:
        dataset = self.write_jsonl("curated.jsonl", [
            {"messages": [{"role": "user", "content": "Question"}, {"role": "assistant", "content": "Answer"}]},
            {"messages": [{"role": "user", "content": "Question 2"}, {"role": "assistant", "content": "Answer 2"}]},
        ])
        artifact_dir = self.root / "not-created"
        report = build_report(dataset, self.root / "missing-model", artifact_dir)
        self.assertFalse(report["ready"])
        self.assertEqual(report["mode"], "preflight-only")
        self.assertFalse(artifact_dir.exists())
        self.assertTrue(any("local Hugging Face" in message for message in report["blockers"]))


if __name__ == "__main__":
    unittest.main()
