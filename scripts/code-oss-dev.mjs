#!/usr/bin/env node
// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproducible development helper for the thin Code-OSS downstream.
 *
 * - `npm run ide:doctor` verifies host prerequisites + overlay presence.
 *   No upstream checkout required.
 * - `npm run ide:check` verifies overlay identity, patch inventory, extension
 *   manifest/boundary, licensing, and (when present) the upstream checkout.
 *
 * Both commands exit 0 on success and non-zero with actionable output on failure.
 * Use `--json` for machine-readable output.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CODE_OSS_DIR = join(REPO_ROOT, "code-oss");
const EXTENSION_DIR = join(REPO_ROOT, "apps", "ide-extension");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function check(name, ok, detail = "") {
  return { name, ok, detail };
}

function detectGitVersion() {
  try {
    const output = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    return { available: true, detail: output };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function listFilesRecursive(directory, relativeBase = directory, output = []) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listFilesRecursive(full, relativeBase, output);
    } else {
      output.push(full.slice(relativeBase.length + 1));
    }
  }
  return output;
}

const LOGO_EXTENSIONS = new Set([".png", ".icns", ".ico"]);

function hasLogoBinary(directory) {
  if (!existsSync(directory)) {
    return false;
  }
  return listFilesRecursive(directory).some((relative) => {
    const lower = relative.toLowerCase();
    // Ignore the git-ignored upstream checkout entirely.
    if (lower === "upstream" || lower.startsWith("upstream/") || lower.startsWith("upstream\\")) {
      return false;
    }
    const dot = lower.lastIndexOf(".");
    if (dot < 0) {
      return false;
    }
    return LOGO_EXTENSIONS.has(lower.slice(dot));
  });
}

function validateUpstreamPin() {
  const results = [];
  const path = join(CODE_OSS_DIR, "upstream.json");
  if (!existsSync(path)) {
    return [check("upstream.json present", false, "code-oss/upstream.json is missing")];
  }
  let pin;
  try {
    pin = readJson(path);
  } catch (error) {
    return [
      check("upstream.json parses", false, error instanceof Error ? error.message : String(error)),
    ];
  }
  results.push(check("upstream.json parses", true));
  results.push(
    check(
      "upstream repository is microsoft/vscode",
      pin.upstreamRepository === "https://github.com/microsoft/vscode.git",
      String(pin.upstreamRepository ?? "missing"),
    ),
  );
  results.push(
    check(
      "checkout directory is git-ignored code-oss/upstream",
      pin.checkoutDirectory === "code-oss/upstream",
      String(pin.checkoutDirectory ?? "missing"),
    ),
  );
  const pinnedRef = pin.pinnedRef ?? null;
  const pinnedOk = pinnedRef === null || /^[0-9a-f]{40}$/.test(pinnedRef);
  results.push(
    check(
      "pinnedRef is null (M0) or a full commit SHA",
      pinnedOk,
      pinnedRef === null ? "null (no checkout certified yet)" : String(pinnedRef),
    ),
  );
  const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
  results.push(
    check(
      "code-oss/upstream/ is git-ignored",
      gitignore.includes("code-oss/upstream/"),
      ".gitignore",
    ),
  );
  return results;
}

function validateProductOverlay() {
  const path = join(CODE_OSS_DIR, "product.overlay.json");
  if (!existsSync(path)) {
    return [
      check("product.overlay.json present", false, "code-oss/product.overlay.json is missing"),
    ];
  }
  const overlay = readJson(path);
  const identity = overlay.identity ?? {};
  const results = [check("product.overlay.json parses", true)];
  results.push(
    check("nameShort is Densa ADE", identity.nameShort === "Densa ADE", String(identity.nameShort)),
  );
  results.push(
    check(
      "applicationName is densa-ade",
      identity.applicationName === "densa-ade",
      String(identity.applicationName),
    ),
  );
  results.push(
    check(
      "applicationName differs from upstream",
      !["code-oss", "code"].includes(identity.applicationName),
      String(identity.applicationName),
    ),
  );
  results.push(
    check(
      "dataFolderName differs from upstream",
      typeof identity.dataFolderName === "string" &&
        identity.dataFolderName.length > 0 &&
        !["Code - OSS", "Code", "code-oss"].includes(identity.dataFolderName),
      String(identity.dataFolderName),
    ),
  );
  results.push(
    check(
      "darwinBundleIdentifier is distinct",
      typeof identity.darwinBundleIdentifier === "string" &&
        identity.darwinBundleIdentifier.length > 0 &&
        !identity.darwinBundleIdentifier.includes("microsoft") &&
        !identity.darwinBundleIdentifier.includes("vscode"),
      String(identity.darwinBundleIdentifier),
    ),
  );
  const branding = overlay.branding ?? {};
  results.push(
    check(
      "branding is text-placeholder with no logo",
      branding.mode === "text-placeholder" && branding.logo === null,
      JSON.stringify(branding),
    ),
  );
  return results;
}

const PATCH_STATUSES = new Set(["proposed", "applied", "upstreamed", "dropped"]);

function validatePatchInventory() {
  const inventoryPath = join(CODE_OSS_DIR, "patches", "inventory.json");
  const results = [];
  if (!existsSync(inventoryPath)) {
    return [
      check("patches/inventory.json present", false, "code-oss/patches/inventory.json is missing"),
    ];
  }
  let inventory;
  try {
    inventory = readJson(inventoryPath);
  } catch (error) {
    return [
      check(
        "patches/inventory.json parses",
        false,
        error instanceof Error ? error.message : String(error),
      ),
    ];
  }
  if (!Array.isArray(inventory)) {
    return [check("patch inventory is an array", false, typeof inventory)];
  }
  results.push(check("patch inventory is an array", true, `${inventory.length} entries`));
  for (const entry of inventory) {
    const id = entry?.id ?? "(missing id)";
    results.push(
      check(
        `patch ${id}: id matches record filename`,
        entry.record === `${entry.id}.md`,
        String(entry.record),
      ),
    );
    results.push(
      check(
        `patch ${id}: upstreamArea non-empty`,
        typeof entry.upstreamArea === "string" && entry.upstreamArea.length > 0,
        String(entry.upstreamArea),
      ),
    );
    results.push(
      check(
        `patch ${id}: reason non-empty`,
        typeof entry.reason === "string" && entry.reason.trim().length > 0,
        "reason",
      ),
    );
    results.push(
      check(
        `patch ${id}: mergeTest non-empty`,
        typeof entry.mergeTest === "string" && entry.mergeTest.trim().length > 0,
        "mergeTest",
      ),
    );
    results.push(
      check(`patch ${id}: status known`, PATCH_STATUSES.has(entry.status), String(entry.status)),
    );
    results.push(
      check(`patch ${id}: MIT retained`, entry.mitRetained === true, String(entry.mitRetained)),
    );
    const recordPath = join(CODE_OSS_DIR, "patches", String(entry.record ?? ""));
    const recordExists = typeof entry.record === "string" && existsSync(recordPath);
    results.push(check(`patch ${id}: record file exists`, recordExists, String(entry.record)));
    if (recordExists) {
      const record = readFileSync(recordPath, "utf8");
      results.push(
        check(
          `patch ${id}: record notes MIT retention`,
          record.includes("MIT retained: true"),
          String(entry.record),
        ),
      );
    }
  }
  return results;
}

function validateExtension() {
  const results = [];
  const manifestPath = join(EXTENSION_DIR, "package.json");
  if (!existsSync(manifestPath)) {
    return [
      check("ide-extension manifest present", false, "apps/ide-extension/package.json is missing"),
    ];
  }
  const manifest = readJson(manifestPath);
  results.push(check("ide-extension manifest parses", true));
  const commands = manifest.contributes?.commands ?? [];
  for (const command of [
    "densa-ade.showDashboard",
    "densa-ade.showRoadmap",
    "densa-ade.showMasterAgent",
    "densa-ade.startProject",
    "densa-ade.resumeProject",
  ]) {
    results.push(
      check(
        `ide-extension contributes ${command}`,
        commands.some((entry) => entry?.command === command),
        command,
      ),
    );
  }
  results.push(
    check(
      "ide-extension commands share the Densa ADE palette group",
      commands.length > 0 && commands.every((entry) => entry?.category === "Densa ADE"),
      commands.map((entry) => entry?.category).join(", ") || "(no commands)",
    ),
  );
  const containers = manifest.contributes?.viewsContainers?.activitybar ?? [];
  results.push(
    check(
      "ide-extension contributes the densa-ade activity bar container",
      containers.some((entry) => entry?.id === "densa-ade"),
      "densa-ade",
    ),
  );
  const views = manifest.contributes?.views?.["densa-ade"] ?? [];
  for (const view of ["densa-ade.dashboard", "densa-ade.roadmap", "densa-ade.master"]) {
    results.push(
      check(
        `ide-extension contributes activity bar view ${view}`,
        views.some((entry) => entry?.id === view),
        view,
      ),
    );
  }
  const customEditors = manifest.contributes?.customEditors ?? [];
  for (const viewType of ["densa-ade.dashboard", "densa-ade.roadmap", "densa-ade.master"]) {
    results.push(
      check(
        `ide-extension contributes editor-area tab ${viewType}`,
        customEditors.some((entry) => entry?.viewType === viewType),
        viewType,
      ),
    );
  }
  const dependencies = Object.keys(manifest.dependencies ?? {});
  results.push(
    check(
      "ide-extension depends on protocol only",
      dependencies.length === 1 && dependencies[0] === "@densa-ade/protocol",
      dependencies.join(", ") || "(no dependencies)",
    ),
  );
  results.push(
    check(
      "ide-extension targets vscode engines",
      typeof manifest.engines?.vscode === "string" && manifest.engines.vscode.length > 0,
      String(manifest.engines?.vscode ?? "missing"),
    ),
  );
  const sources = [
    "index.ts",
    "connection.ts",
    "runtime-paths.ts",
    "ide-transport.ts",
    "event-cache.ts",
    "ide-connection.ts",
    "welcome.ts",
    "surfaces.ts",
    "roadmap.ts",
    "dashboard.ts",
    "master.ts",
  ].map((file) => join(EXTENSION_DIR, "src", file));
  for (const source of sources) {
    results.push(
      check(
        `ide-extension source present: ${source.split("/").slice(-1)}`,
        existsSync(source),
        source,
      ),
    );
  }
  const combined = sources
    .filter((source) => existsSync(source))
    .map((source) => readFileSync(source, "utf8"))
    .join("\n");
  const forbiddenImports = [
    {
      label: "@densa-ade/core import",
      pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/core(?:\/[^"']*)?["']/u,
    },
    {
      label: "@densa-ade/cli import",
      pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/cli(?:\/[^"']*)?["']/u,
    },
    {
      label: "vs/workbench import",
      pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*vs\/workbench[^"']*["']/u,
    },
    {
      label: "vscode import",
      pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']vscode["']/u,
    },
    {
      label: "sqlite import",
      pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*sqlite[^"']*["']/iu,
    },
  ];
  for (const forbidden of forbiddenImports) {
    results.push(
      check(
        `ide-extension source avoids ${forbidden.label}`,
        !forbidden.pattern.test(combined),
        forbidden.label,
      ),
    );
  }
  return results;
}

function validateLicensing() {
  const results = [];
  const licensePath = join(REPO_ROOT, "LICENSE");
  const noticesPath = join(REPO_ROOT, "THIRD_PARTY_NOTICES.md");
  results.push(check("LICENSE present", existsSync(licensePath), "LICENSE"));
  results.push(
    check("THIRD_PARTY_NOTICES.md present", existsSync(noticesPath), "THIRD_PARTY_NOTICES.md"),
  );
  if (existsSync(licensePath)) {
    const license = readFileSync(licensePath, "utf8");
    results.push(
      check(
        "LICENSE is Apache 2.0",
        license.includes("Apache License") && license.includes("Version 2.0"),
        "LICENSE",
      ),
    );
  }
  if (existsSync(noticesPath)) {
    const notices = readFileSync(noticesPath, "utf8");
    results.push(
      check(
        "third-party notices preserve Microsoft MIT",
        notices.includes("Microsoft Corporation") &&
          notices.includes("Permission is hereby granted"),
        "THIRD_PARTY_NOTICES.md",
      ),
    );
    results.push(
      check(
        "third-party notices name Code-OSS upstream",
        notices.includes("microsoft/vscode"),
        "THIRD_PARTY_NOTICES.md",
      ),
    );
  }
  const rootPackage = readJson(join(REPO_ROOT, "package.json"));
  results.push(
    check(
      "root package license is Apache-2.0",
      rootPackage.license === "Apache-2.0",
      String(rootPackage.license),
    ),
  );
  return results;
}

export function runDoctor() {
  const results = [];
  const nodeMajor = Number(process.version.slice(1).split(".")[0]);
  results.push(check("node >=22.13.0", nodeMajor >= 22, process.version));
  const git = detectGitVersion();
  results.push(check("git available", git.available, git.detail));
  results.push(check("platform recorded", true, `${process.platform} (${process.arch})`));
  for (const file of [
    "code-oss/README.md",
    "code-oss/UPSTREAM.md",
    "code-oss/product.overlay.json",
    "apps/ide-extension/package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    results.push(check(`${file} present`, existsSync(join(REPO_ROOT, file)), file));
  }
  return { ok: results.every((entry) => entry.ok), checks: results };
}

export function runCheck() {
  const groups = [
    validateUpstreamPin(),
    validateProductOverlay(),
    validatePatchInventory(),
    validateExtension(),
    validateLicensing(),
    [
      check("no placeholder logo binaries in code-oss/", !hasLogoBinary(CODE_OSS_DIR), "code-oss/"),
      check(
        "no placeholder logo binaries in apps/ide-extension/",
        !hasLogoBinary(EXTENSION_DIR),
        "apps/ide-extension/",
      ),
      check(
        "no vendored upstream workbench tree",
        !existsSync(join(CODE_OSS_DIR, "vs")) && !existsSync(join(CODE_OSS_DIR, "src")),
        "code-oss/ carries overlays only",
      ),
    ],
  ];
  const checks = groups.flat();
  return { ok: checks.every((entry) => entry.ok), checks };
}

function printHuman(result, title) {
  console.log(`${title}: ${result.ok ? "OK" : "FAIL"}`);
  for (const entry of result.checks) {
    console.log(
      `  ${entry.ok ? "ok" : "FAIL"} - ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`,
    );
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const mode = process.argv[2] ?? "doctor";
  const asJson = process.argv.includes("--json");
  const result = mode === "check" ? runCheck() : runDoctor();
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result, mode === "check" ? "ide:check" : "ide:doctor");
  }
  process.exit(result.ok ? 0 : 1);
}
