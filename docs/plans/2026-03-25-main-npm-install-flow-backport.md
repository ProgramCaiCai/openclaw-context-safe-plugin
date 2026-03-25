# Main Npm Install Flow Backport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Backport the packaged npm install flow from `dev` into `main` without carrying any `dev`-only behavior, release metadata, or runtime changes.

**Architecture:** Keep `main` as the single source of truth for what gets installed by packaging the current `main` worktree into a `.tgz` and passing that archive to the official `openclaw plugins install` command. Preserve an explicit `--link` path for mutable local development, and align README guidance with that canonical default.

**Tech Stack:** Python 3, npm pack, OpenClaw CLI, Vitest, TypeScript

---

### Task 1: Lock in install-script behavior with tests

**Files:**
- Modify: `src/package-manifest.test.ts`
- Test: `src/package-manifest.test.ts`

**Step 1: Write the failing test**

Add assertions that:
- `package.json` exposes both `install:plugin` and `install:plugin:link`
- the packaged install helper script remains published

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --config vitest.config.ts src/package-manifest.test.ts`
Expected: FAIL because `install:plugin:link` is missing from `package.json`

**Step 3: Write minimal implementation**

Update `package.json` scripts only as needed to satisfy the install entrypoint contract.

**Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --config vitest.config.ts src/package-manifest.test.ts`
Expected: PASS

### Task 2: Backport the packaged install path

**Files:**
- Modify: `scripts/install.py`
- Test: `python3 -m py_compile scripts/install.py`

**Step 1: Write the failing test**

Use the manifest test from Task 1 as the red test, then inspect `python3 scripts/install.py --dry-run` output to confirm the current default still targets the repo path instead of a packed archive.

**Step 2: Run checks to verify current failure**

Run:
- `pnpm exec vitest run --config vitest.config.ts src/package-manifest.test.ts`
- `python3 scripts/install.py --dry-run`

Expected:
- manifest test fails before implementation
- dry run shows repo-path install instead of `npm pack` + `.tgz` install

**Step 3: Write minimal implementation**

Change the installer so that:
- default install runs `npm pack --json --pack-destination <tmp-dir>`
- the resulting `.tgz` path is installed with `openclaw plugins install <archive>`
- `--link` remains the only path that installs the mutable repo directly
- uninstall, `--no-config`, `--dry-run`, and reinstall-on-existing-plugin behavior remain intact

**Step 4: Run checks to verify it passes**

Run:
- `python3 -m py_compile scripts/install.py`
- `python3 scripts/install.py --dry-run`

Expected:
- Python compile succeeds
- dry run prints `npm pack` followed by `openclaw plugins install <tmp-dir>/<name>-<version>.tgz`

### Task 3: Align documentation with the canonical install path

**Files:**
- Modify: `README.md`

**Step 1: Write the failing check**

Identify README install sections that still recommend `openclaw plugins install --link .` or copy-install from the repo path as the default.

**Step 2: Verify mismatch exists**

Run: `rg -n "openclaw plugins install --link \\.|openclaw plugins install \\.$|Install:|安装：" README.md`
Expected: current README still presents source-path install as the primary flow

**Step 3: Write minimal implementation**

Update both Chinese and English install sections so that:
- `scripts/install.py` is the recommended first path
- default install means pack then install the generated archive
- `--link` is explicitly local-development-only
- official manual commands show the archive-based path first

**Step 4: Run checks to verify it passes**

Run: `rg -n "npm pack|--link|scripts/install.py" README.md`
Expected: README shows pack-first default plus explicit `--link` development guidance

### Task 4: Final verification

**Files:**
- Verify only

**Step 1: Run targeted verification**

Run:
- `pnpm exec vitest run --config vitest.config.ts src/package-manifest.test.ts`
- `python3 -m py_compile scripts/install.py`
- `python3 scripts/install.py --dry-run`

**Step 2: Review final diff**

Run: `git diff -- README.md package.json scripts/install.py src/package-manifest.test.ts`
Expected: only install-flow backport changes are present
