import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCheck, runDoctor } from "./code-oss-dev.mjs";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CODE_OSS_DIR = join(REPO_ROOT, "code-oss");
const EXTENSION_DIR = join(REPO_ROOT, "apps", "ide-extension");

function readText(relative) {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

function readJson(relative) {
  return JSON.parse(readText(relative));
}

function listFilesRecursive(directory) {
  const output = [];
  if (!existsSync(directory)) {
    return output;
  }
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        output.push(full);
      }
    }
  };
  walk(directory);
  return output;
}

test("Apache 2.0 is the official Densa ADE license and Microsoft MIT is preserved", () => {
  const license = readText("LICENSE");
  assert.match(license, /Apache License/u);
  assert.match(license, /Version 2\.0/u);
  assert.match(license, /http:\/\/www\.apache\.org\/licenses\//u);

  const notices = readText("THIRD_PARTY_NOTICES.md");
  assert.match(notices, /Microsoft Corporation/u);
  assert.match(notices, /Permission is hereby granted/u);
  assert.match(notices, /microsoft\/vscode/u);
  assert.match(notices, /Apache License/u);

  const readme = readText("README.md");
  assert.match(readme, /Apache License/u);
  assert.match(readme, /THIRD_PARTY_NOTICES/u);

  assert.equal(readJson("package.json").license, "Apache-2.0");
  for (const relative of [
    "packages/protocol/package.json",
    "packages/agent-sdk/package.json",
    "packages/core/package.json",
    "packages/cli/package.json",
    "packages/testing/package.json",
    "apps/ide-extension/package.json",
  ]) {
    assert.equal(readJson(relative).license, "Apache-2.0", relative);
  }
});

test("upstream tracking strategy is clean and machine-readable", () => {
  const upstreamDoc = readText("code-oss/UPSTREAM.md");
  assert.match(upstreamDoc, /microsoft\/vscode/u);
  assert.match(upstreamDoc, /code-oss\/upstream\//u);
  assert.match(upstreamDoc, /pinnedRef/u);

  const pin = readJson("code-oss/upstream.json");
  assert.equal(pin.upstreamRepository, "https://github.com/microsoft/vscode.git");
  assert.equal(pin.trackingBranch, "main");
  assert.equal(pin.checkoutDirectory, "code-oss/upstream");
  assert.ok(pin.pinnedRef === null || /^[0-9a-f]{40}$/.test(pin.pinnedRef));

  const gitignore = readText(".gitignore");
  assert.match(gitignore, /code-oss\/upstream\//u);

  assert.ok(!existsSync(join(CODE_OSS_DIR, "vs")), "upstream source must not be vendored");
  assert.ok(!existsSync(join(CODE_OSS_DIR, "src")), "upstream source must not be vendored");
});

test("downstream product identity is distinct with placeholder branding only", () => {
  const overlay = readJson("code-oss/product.overlay.json");
  assert.equal(overlay.identity.nameShort, "Densa ADE");
  assert.equal(overlay.identity.applicationName, "densa-ade");
  assert.ok(!["code-oss", "code"].includes(overlay.identity.applicationName));
  assert.ok(typeof overlay.identity.dataFolderName === "string");
  assert.ok(!["Code - OSS", "Code", "code-oss"].includes(overlay.identity.dataFolderName));
  assert.ok(typeof overlay.identity.darwinBundleIdentifier === "string");
  assert.ok(!overlay.identity.darwinBundleIdentifier.includes("microsoft"));
  assert.ok(!overlay.identity.darwinBundleIdentifier.includes("vscode"));
  assert.equal(overlay.branding.mode, "text-placeholder");
  assert.equal(overlay.branding.logo, null);
  assert.ok(
    overlay.preservedUpstreamBehavior.includes("terminal"),
    "editor behavior preservation must be explicit",
  );

  const branding = readText("code-oss/BRANDING.md");
  assert.match(branding, /placeholder/iu);
  assert.match(branding, /logo comes later/iu);

  const logoBinaries = listFilesRecursive(CODE_OSS_DIR)
    .concat(listFilesRecursive(EXTENSION_DIR))
    .filter((full) => !full.includes(`${join("code-oss", "upstream")}${"/"}`))
    .filter((full) =>
      [".png", ".icns", ".ico"].some((extension) => full.toLowerCase().endsWith(extension)),
    );
  assert.deepEqual(logoBinaries, []);
});

test("direct upstream patchset is empty at M0 and fully inventoried", () => {
  const inventory = readJson("code-oss/patches/inventory.json");
  assert.deepEqual(inventory, []);

  const template = readText("code-oss/patches/0000-template.md");
  assert.match(template, /Why an extension contribution could not do the job/u);
  assert.match(template, /How to test during upstream merges/u);
  assert.match(template, /MIT retained: true/u);

  const patchesDoc = readText("code-oss/PATCHES.md");
  assert.match(patchesDoc, /No direct upstream patches at Phase 10 Milestone 0/u);
  assert.match(patchesDoc, /inventory\.json/u);

  const patchReadme = readText("code-oss/patches/README.md");
  assert.match(patchReadme, /mitRetained/u);
});

test("built-in extension is a protocol-only Core client scaffold", async () => {
  const manifest = readJson("apps/ide-extension/package.json");
  const commands = manifest.contributes.commands.map((entry) => entry.command);
  for (const command of [
    "densa-ade.showDashboard",
    "densa-ade.showRoadmap",
    "densa-ade.showMasterAgent",
  ]) {
    assert.ok(commands.includes(command), command);
  }
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@densa-ade/protocol"]);
  assert.ok(typeof manifest.engines?.vscode === "string");

  const extension = await import("../apps/ide-extension/dist/index.js");
  assert.equal(extension.EXTENSION_ID, "densa-labs.densa-ade");
  assert.equal(extension.PRODUCT_BINDING.applicationName, "densa-ade");
  assert.equal(extension.describeExtension().coreBoundary, "protocol-only");
  assert.ok(extension.IDE_COMMANDS.includes("densa-ade.showDashboard"));
  assert.ok(extension.IDE_VIEWS.includes("densa-ade.dashboard"));

  const valid = extension.createIdeConnectionOptions({
    socketPath: "/tmp/densa-core.sock",
    authToken: "token",
  });
  assert.equal(valid.protocolVersion, "1.0.0");
  assert.throws(
    () => extension.createIdeConnectionOptions({ socketPath: "", authToken: "token" }),
    /socketPath/u,
  );
  assert.throws(() => extension.assertCompatibleProtocol("0.0.0"), /protocol mismatch/iu);

  const combined =
    readText("apps/ide-extension/src/index.ts") + readText("apps/ide-extension/src/connection.ts");
  const forbiddenImports = [
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/core(?:\/[^"']*)?["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*vs\/workbench[^"']*["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']vscode["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*sqlite[^"']*["']/iu,
  ];
  for (const pattern of forbiddenImports) {
    assert.ok(!pattern.test(combined), String(pattern));
  }
});

test("downstream docs and repository wiring are complete", () => {
  for (const relative of [
    "code-oss/README.md",
    "code-oss/UPSTREAM.md",
    "code-oss/DEVELOPMENT.md",
    "code-oss/BRANDING.md",
    "code-oss/PATCHES.md",
    "docs/code-oss-downstream.md",
    "apps/ide-extension/README.md",
  ]) {
    assert.ok(existsSync(join(REPO_ROOT, relative)), relative);
  }
  const downstreamDoc = readText("docs/code-oss-downstream.md");
  assert.match(downstreamDoc, /Phase 9 is complete/u);
  assert.match(downstreamDoc, /protocol-only/u);

  const rootPackage = readJson("package.json");
  assert.ok(typeof rootPackage.scripts["ide:doctor"] === "string");
  assert.ok(typeof rootPackage.scripts["ide:check"] === "string");
  assert.match(rootPackage.scripts.pretest, /apps\/ide-extension/u);

  const buildConfig = readJson("tsconfig.build.json");
  assert.ok(buildConfig.references.some((entry) => entry.path === "./apps/ide-extension"));
});

test("ide:doctor and ide:check pass on this checkout", () => {
  const doctor = runDoctor();
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks.filter((entry) => !entry.ok)));
  const checked = runCheck();
  assert.equal(checked.ok, true, JSON.stringify(checked.checks.filter((entry) => !entry.ok)));
});
