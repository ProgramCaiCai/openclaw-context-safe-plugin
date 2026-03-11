#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copy-install the OpenClaw Context Safe plugin into an OpenClaw installation."
    )
    parser.add_argument(
        "--openclaw-bin",
        default=os.environ.get("OPENCLAW_BIN", "openclaw"),
        help="Path to the openclaw executable to use.",
    )
    parser.add_argument(
        "--install-dir",
        help="Optional staging directory to materialize the installable plugin copy.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Prepare the install layout and print commands without executing them.",
    )
    parser.add_argument(
        "--no-config",
        action="store_true",
        help="Install the plugin but do not enable it or select its contextEngine slot.",
    )
    parser.add_argument(
        "--keep-staged-copy",
        action="store_true",
        help="Keep the staged install directory after completion.",
    )
    return parser.parse_args()


def repo_project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def read_manifest(project_root: Path) -> dict:
    manifest_path = project_root / "openclaw.plugin.json"
    try:
        return json.loads(manifest_path.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Missing plugin manifest: {manifest_path}") from exc


def read_install_source_paths(project_root: Path) -> tuple[str, ...]:
    package_json_path = project_root / "package.json"
    try:
        manifest = json.loads(package_json_path.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Missing package manifest: {package_json_path}") from exc

    raw_files = manifest.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise SystemExit(f"package.json files must be a non-empty array: {package_json_path}")

    install_paths = ["package.json"]
    for entry in raw_files:
        if not isinstance(entry, str) or not entry.strip():
            raise SystemExit(f"package.json files contains an invalid entry: {entry!r}")
        install_paths.append(entry.strip())
    return tuple(dict.fromkeys(install_paths))


def materialize_install_layout(project_root: Path, install_dir: Path) -> None:
    install_source_paths = read_install_source_paths(project_root)
    install_dir.mkdir(parents=True, exist_ok=True)
    for relative_path in install_source_paths:
        source_path = project_root / relative_path
        if not source_path.exists():
            raise SystemExit(f"Missing required install source: {source_path}")
        target_path = install_dir / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path)


def build_install_plan(openclaw_bin: str, install_dir: Path, plugin_id: str, apply_config: bool) -> list[list[str]]:
    commands: list[list[str]] = [[openclaw_bin, "plugins", "install", str(install_dir)]]
    if apply_config:
        commands.extend(
            [
                [openclaw_bin, "config", "set", f"plugins.entries.{plugin_id}.enabled", "true"],
                [openclaw_bin, "config", "set", "plugins.slots.contextEngine", plugin_id],
            ]
        )
    return commands


def run_command(command: list[str]) -> None:
    try:
        subprocess.run(command, check=True)
    except FileNotFoundError as exc:
        raise SystemExit(f"Command not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        joined = " ".join(command)
        raise SystemExit(f"Command failed ({exc.returncode}): {joined}") from exc


def main() -> int:
    args = parse_args()
    project_root = repo_project_root()
    manifest = read_manifest(project_root)
    plugin_id = str(manifest.get("id", "")).strip()
    if not plugin_id:
        raise SystemExit("Plugin manifest is missing a non-empty id")

    temp_dir: Path | None = None
    if args.install_dir:
        install_dir = Path(args.install_dir).expanduser().resolve()
    else:
        temp_dir = Path(tempfile.mkdtemp(prefix=f"{plugin_id}-install-"))
        install_dir = temp_dir

    keep_staged_copy = args.keep_staged_copy or args.install_dir is not None or args.dry_run

    try:
        materialize_install_layout(project_root, install_dir)
        commands = build_install_plan(
            openclaw_bin=args.openclaw_bin,
            install_dir=install_dir,
            plugin_id=plugin_id,
            apply_config=not args.no_config,
        )

        print(f"Staged install directory: {install_dir}")
        for command in commands:
            print("$ " + " ".join(command))

        if args.dry_run:
            return 0

        for command in commands:
            run_command(command)
        return 0
    finally:
        if temp_dir is not None and not keep_staged_copy:
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
