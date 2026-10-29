"""Read-only local base-model and hardware preflight; this module never trains."""

from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from training.dataset import DatasetValidationError, load_dataset

TRAINING_MODULES = ("torch", "transformers", "peft", "bitsandbytes")


def available_ram_gib() -> float | None:
    if platform.system() == "Windows":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("memory_load", ctypes.c_ulong),
                ("total_physical", ctypes.c_ulonglong),
                ("available_physical", ctypes.c_ulonglong),
                ("total_page_file", ctypes.c_ulonglong),
                ("available_page_file", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong),
                ("available_virtual", ctypes.c_ulonglong),
                ("available_extended_virtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.available_physical / (1024**3)
        return None

    meminfo = Path("/proc/meminfo")
    if meminfo.is_file():
        for line in meminfo.read_text(encoding="ascii").splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / (1024**2)
    return None


def gpu_vram_gib() -> list[float] | None:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return None
    try:
        result = subprocess.run(
            [executable, "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        return [float(line.strip()) / 1024 for line in result.stdout.splitlines() if line.strip()]
    except ValueError:
        return None


def model_files(model_dir: Path) -> tuple[dict[str, Any] | None, int, list[str]]:
    errors: list[str] = []
    if not model_dir.is_dir():
        return None, 0, ["Base model must be an existing local Hugging Face model directory; downloads are disabled."]
    config_path = model_dir / "config.json"
    if not config_path.is_file():
        return None, 0, ["Missing config.json; GGUF and other non-Hugging-Face exports are not trainable by this preflight."]
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None, 0, ["config.json could not be read as valid JSON."]
    if not isinstance(config, dict) or not isinstance(config.get("model_type"), str):
        errors.append("config.json does not declare a model_type.")
    if not any((model_dir / name).is_file() for name in ("tokenizer.json", "tokenizer.model", "spiece.model")):
        errors.append("No local tokenizer file was found; automatic tokenizer downloads are disabled.")
    weight_files = list(model_dir.glob("*.safetensors")) + list(model_dir.glob("pytorch_model*.bin"))
    if not weight_files:
        errors.append("No local PyTorch or safetensors weights were found.")
    total_weight_bytes = 0
    for weight_file in weight_files:
        try:
            total_weight_bytes += weight_file.stat().st_size
        except OSError:
            errors.append("Could not inspect one or more local model weight files.")
            break
    if not ((model_dir / "LICENSE").is_file() or (model_dir / "LICENSE.txt").is_file() or config.get("license")):
        errors.append("Model license is not declared locally; verify license and training permissions before use.")
    return config, total_weight_bytes, errors


def build_report(dataset_path: Path, model_dir: Path, artifact_dir: Path) -> dict[str, Any]:
    blockers: list[str] = []
    warnings: list[str] = []
    try:
        examples, dataset_errors = load_dataset(dataset_path)
        if dataset_errors:
            blockers.append(f"Dataset has {len(dataset_errors)} validation error(s).")
        elif len(examples) < 2:
            blockers.append("At least two unique curated examples are required.")
    except (OSError, UnicodeError, DatasetValidationError) as error:
        examples = []
        blockers.append(f"Dataset validation failed: {error}")

    config, model_bytes, model_errors = model_files(model_dir)
    blockers.extend(model_errors)
    ram = available_ram_gib()
    vram = gpu_vram_gib()
    if ram is None:
        warnings.append("Available system RAM could not be measured on this operating system.")
    elif ram < 8:
        blockers.append(f"Only {ram:.1f} GiB system RAM is currently available; at least 8 GiB is required even for the conservative preflight.")
    elif ram < 16:
        warnings.append(f"Only {ram:.1f} GiB system RAM is currently available; CPU/offloaded training will be slow.")
    if vram is None:
        blockers.append("NVIDIA GPU VRAM could not be verified; this preflight does not certify CPU-only or offloaded training.")
    elif not vram or max(vram) < 8:
        blockers.append(f"Detected NVIDIA VRAM {vram}; at least 8 GiB is required for conservative LoRA/QLoRA preflight.")

    missing_modules = [name for name in TRAINING_MODULES if importlib.util.find_spec(name) is None]
    if missing_modules:
        blockers.append("Training dependencies are not installed in this Python environment: " + ", ".join(missing_modules) + ".")

    artifact_dir = artifact_dir.expanduser()
    if artifact_dir.exists() and not artifact_dir.is_dir():
        blockers.append("Artifact destination exists and is not a directory.")
    if artifact_dir.exists() and not os.access(artifact_dir, os.W_OK):
        blockers.append("Artifact destination is not writable.")
    try:
        disk_path = artifact_dir if artifact_dir.exists() else artifact_dir.parent
        if not disk_path.exists():
            disk_path = Path.home()
        free_bytes = shutil.disk_usage(disk_path).free
        required_bytes = max(10 * 1024**3, model_bytes * 2 + dataset_path.stat().st_size * 2)
        if free_bytes < required_bytes:
            blockers.append(f"Only {free_bytes / (1024**3):.1f} GiB disk is free; estimated minimum is {required_bytes / (1024**3):.1f} GiB.")
    except OSError:
        warnings.append("Free disk space could not be checked for the artifact destination.")

    if config and isinstance(config.get("model_type"), str):
        warnings.append(f"Architecture '{config['model_type']}' still needs verification against the exact trainer and quantization versions.")
    warnings.append("This command is a read-only preflight only. It never downloads models, installs packages, creates artifacts, or starts training.")
    return {
        "ready": not blockers,
        "mode": "preflight-only",
        "baseModel": str(model_dir),
        "dataset": str(dataset_path),
        "artifactDirectory": str(artifact_dir),
        "validatedExamples": len(examples),
        "availableRamGiB": round(ram, 2) if ram is not None else None,
        "gpuVramGiB": [round(value, 2) for value in vram] if vram is not None else None,
        "baseWeightBytes": model_bytes,
        "blockers": blockers,
        "warnings": warnings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path, help="curated JSONL examples")
    parser.add_argument("--base-model", required=True, type=Path, help="existing local Hugging Face model directory")
    default_artifacts = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "Maya AI" / "training"
    parser.add_argument("--artifact-dir", type=Path, default=default_artifacts)
    args = parser.parse_args(argv)
    report = build_report(args.dataset, args.base_model, args.artifact_dir)
    print(json.dumps(report, indent=2))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
