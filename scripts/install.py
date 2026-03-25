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
        "--link",
        action="store_true",
        help="Install from the mutable repo path with `openclaw plugins install --link`.",
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


def read_package_metadata(project_root: Path) -> tuple[str, str]:
    package_path = project_root / "package.json"
    try:
        package_data = json.loads(package_path.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Missing package manifest: {package_path}") from exc

    package_name = str(package_data.get("name", "")).strip()
    package_version = str(package_data.get("version", "")).strip()
    if not package_name or not package_version:
        raise SystemExit("package.json is missing a non-empty name/version")
    return package_name, package_version


def package_artifact_dir(package_name: str) -> Path:
    safe_name = package_name.lstrip("@").replace("/", "-")
    return Path("/tmp") / f"{safe_name}-npm-artifacts"


def package_artifact_name(package_name: str, package_version: str) -> str:
    safe_name = package_name.lstrip("@").replace("/", "-")
    return f"{safe_name}-{package_version}.tgz"


def resolve_pack_artifact(
    pack_result: subprocess.CompletedProcess[str],
    artifact_dir: Path,
    package_name: str,
    package_version: str,
) -> Path:
    try:
        payload = json.loads(pack_result.stdout)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, list) and payload and isinstance(payload[0], dict):
        filename = str(payload[0].get("filename", "")).strip()
        if filename:
            return artifact_dir / filename

    return artifact_dir / package_artifact_name(package_name, package_version)


def build_install_plan(
    openclaw_bin: str,
    plugin_id: str,
    apply_config: bool,
    install_target: Path,
    link_mode: bool,
) -> list[list[str]]:
    install_command = [openclaw_bin, "plugins", "install"]
    if link_mode:
        install_command.append("--link")
    install_command.append(str(install_target))
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


def run_command(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, check=False, capture_output=True, text=True, cwd=cwd)
    except FileNotFoundError as exc:
        raise SystemExit(f"Command not found: {command[0]}") from exc


def ensure_success(
    command: list[str],
    result: subprocess.CompletedProcess[str],
    *,
    print_stdout: bool = True,
) -> None:
    if result.returncode == 0:
        if print_stdout and result.stdout.strip():
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
    package_name, package_version = read_package_metadata(project_root)
    plugin_id = str(manifest.get("id", "")).strip()
    if not plugin_id:
        raise SystemExit("Plugin manifest is missing a non-empty id")

    pack_command: list[str] | None = None
    artifact_path: Path | None = None
    if args.uninstall:
        commands = build_uninstall_plan(args.openclaw_bin, plugin_id)
    elif args.link:
        commands = build_install_plan(
            openclaw_bin=args.openclaw_bin,
            plugin_id=plugin_id,
            apply_config=not args.no_config,
            install_target=project_root,
            link_mode=True,
        )
    else:
        artifact_dir = package_artifact_dir(package_name)
        artifact_path = artifact_dir / package_artifact_name(package_name, package_version)
        pack_command = ["npm", "pack", "--json", "--pack-destination", str(artifact_dir)]
        commands = build_install_plan(
            openclaw_bin=args.openclaw_bin,
            plugin_id=plugin_id,
            apply_config=not args.no_config,
            install_target=artifact_path,
            link_mode=False,
        )

    if pack_command is not None:
        print("$ " + " ".join(pack_command))
    for command in commands:
        print("$ " + " ".join(command))

    if args.dry_run:
        return 0

    if args.uninstall:
        for command in commands:
            ensure_success(command, run_command(command))
        return 0

    if pack_command is not None:
        artifact_dir = package_artifact_dir(package_name)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        pack_result = run_command(pack_command, cwd=project_root)
        ensure_success(pack_command, pack_result, print_stdout=False)
        artifact_path = resolve_pack_artifact(pack_result, artifact_dir, package_name, package_version)
        if not artifact_path.is_file():
            raise SystemExit(f"Expected packed artifact was not created: {artifact_path}")
        commands[0][-1] = str(artifact_path)
        print(f"Packed plugin archive: {artifact_path}")

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
