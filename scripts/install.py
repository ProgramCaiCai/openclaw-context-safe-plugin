#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install or uninstall the OpenClaw Context Safe plugin via official OpenClaw CLI commands."
    )
    parser.add_argument(
        "--openclaw-bin",
        default=os.environ.get("OPENCLAW_BIN", "openclaw"),
        help="Path to the openclaw executable to use.",
    )
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="Uninstall the plugin with the official OpenClaw CLI.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the official OpenClaw commands without executing them.",
    )
    parser.add_argument(
        "--no-config",
        action="store_true",
        help="Install the plugin but do not enable it or select its contextEngine slot.",
    )
    parser.add_argument(
        "--copy",
        action="store_true",
        help="Use `openclaw plugins install <path>` instead of `--link`.",
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


def build_install_plan(
    openclaw_bin: str,
    project_root: Path,
    plugin_id: str,
    apply_config: bool,
    link_mode: bool,
) -> list[list[str]]:
    install_command = [openclaw_bin, "plugins", "install"]
    if link_mode:
        install_command.append("--link")
    install_command.append(str(project_root))
    commands: list[list[str]] = [install_command]
    if apply_config:
        commands.extend(
            [
                [openclaw_bin, "config", "set", f"plugins.entries.{plugin_id}.enabled", "true"],
                [openclaw_bin, "config", "set", "plugins.slots.contextEngine", plugin_id],
            ]
        )
    return commands


def build_uninstall_plan(openclaw_bin: str, plugin_id: str) -> list[list[str]]:
    return [[openclaw_bin, "plugins", "uninstall", plugin_id, "--force"]]


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, check=False, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise SystemExit(f"Command not found: {command[0]}") from exc


def ensure_success(command: list[str], result: subprocess.CompletedProcess[str]) -> None:
    if result.returncode == 0:
        if result.stdout.strip():
            print(result.stdout.rstrip())
        if result.stderr.strip():
            print(result.stderr.rstrip(), file=sys.stderr)
        return

    joined = " ".join(command)
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    if output:
        raise SystemExit(f"Command failed ({result.returncode}): {joined}\n{output}")
    raise SystemExit(f"Command failed ({result.returncode}): {joined}")


def main() -> int:
    args = parse_args()
    project_root = repo_project_root()
    manifest = read_manifest(project_root)
    plugin_id = str(manifest.get("id", "")).strip()
    if not plugin_id:
        raise SystemExit("Plugin manifest is missing a non-empty id")

    commands = (
        build_uninstall_plan(args.openclaw_bin, plugin_id)
        if args.uninstall
        else build_install_plan(
            openclaw_bin=args.openclaw_bin,
            project_root=project_root,
            plugin_id=plugin_id,
            apply_config=not args.no_config,
            link_mode=not args.copy,
        )
    )

    for command in commands:
        print("$ " + " ".join(command))

    if args.dry_run:
        return 0

    if args.uninstall:
        for command in commands:
            ensure_success(command, run_command(command))
        return 0

    install_command = commands[0]
    install_result = run_command(install_command)
    if install_result.returncode != 0:
        combined = "\n".join(part.strip() for part in (install_result.stdout, install_result.stderr) if part.strip())
        if "plugin already exists:" in combined:
            uninstall_command = build_uninstall_plan(args.openclaw_bin, plugin_id)[0]
            uninstall_result = run_command(uninstall_command)
            ensure_success(uninstall_command, uninstall_result)
            install_result = run_command(install_command)
        ensure_success(install_command, install_result)
    else:
        ensure_success(install_command, install_result)

    for command in commands[1:]:
        ensure_success(command, run_command(command))
    return 0


if __name__ == "__main__":
    sys.exit(main())
