import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

import { runCheck } from "./code-oss-dev.mjs";
import {
  EXTENSIONS_GALLERY_EXTENSION_URL_TEMPLATE,
  EXTENSIONS_GALLERY_ITEM_URL,
  EXTENSIONS_GALLERY_LIFECYCLE,
  EXTENSIONS_GALLERY_REGISTRY_HOME_URL,
  EXTENSIONS_GALLERY_REGISTRY_ID,
  EXTENSIONS_GALLERY_REGISTRY_LABEL,
  EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE,
  EXTENSIONS_GALLERY_SERVICE_URL,
  EXTENSIONS_GALLERY_VERSION,
  buildGalleryModel,
  classifyGalleryFailure,
  describeMarketplaceOnlyUnavailable,
  getExtensionsGalleryConfig,
  getGalleryAboutCopy,
  getGalleryRegistryLabel,
  getGallerySettingsCopy,
  parseGalleryExtensionId,
  resolveGalleryItemUrl,
  resolveGalleryLatestUrl,
  resolveGalleryOperation,
  resolveGalleryResourceUrl,
} from "../apps/ide-extension/dist/index.js";

const EXPECTED = Object.freeze({
  serviceUrl: "https://open-vsx.org/vscode/gallery",
  itemUrl: "https://open-vsx.org/vscode/item",
  resourceUrlTemplate: "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
  extensionUrlTemplate: "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest",
});

function readText(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("overlay pins the downstream gallery to Open VSX", () => {
  const overlay = JSON.parse(readText("../code-oss/product.overlay.json"));
  const gallery = overlay.identity.extensionsGallery;
  assert.equal(gallery.serviceUrl, EXPECTED.serviceUrl);
  assert.equal(gallery.itemUrl, EXPECTED.itemUrl);
  assert.equal(gallery.resourceUrlTemplate, EXPECTED.resourceUrlTemplate);
  assert.equal(gallery.extensionUrlTemplate, EXPECTED.extensionUrlTemplate);
  for (const value of Object.values(gallery)) {
    if (typeof value === "string") {
      assert.ok(value.startsWith("https://open-vsx.org/") || !value.includes("://"));
    }
  }
  assert.ok(!JSON.stringify(gallery).includes("marketplace.visualstudio.com"));
  assert.ok(!JSON.stringify(gallery).includes("marketplace.microsoft.com"));
  assert.equal(EXTENSIONS_GALLERY_SERVICE_URL, EXPECTED.serviceUrl);
  assert.equal(EXTENSIONS_GALLERY_ITEM_URL, EXPECTED.itemUrl);
  assert.equal(EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE, EXPECTED.resourceUrlTemplate);
  assert.equal(EXTENSIONS_GALLERY_EXTENSION_URL_TEMPLATE, EXPECTED.extensionUrlTemplate);
});

test("extension gallery constants label Open VSX without claiming Marketplace", () => {
  assert.equal(EXTENSIONS_GALLERY_VERSION, 1);
  assert.equal(EXTENSIONS_GALLERY_REGISTRY_ID, "open-vsx");
  assert.equal(EXTENSIONS_GALLERY_REGISTRY_LABEL, "Open VSX Registry");
  assert.equal(EXTENSIONS_GALLERY_REGISTRY_HOME_URL, "https://open-vsx.org/");
  assert.equal(getGalleryRegistryLabel(), "Open VSX Registry");

  const config = getExtensionsGalleryConfig();
  assert.deepEqual(
    { ...config },
    {
      version: 1,
      registryId: "open-vsx",
      registryLabel: "Open VSX Registry",
      registryHomeUrl: "https://open-vsx.org/",
      serviceUrl: EXPECTED.serviceUrl,
      itemUrl: EXPECTED.itemUrl,
      resourceUrlTemplate: EXPECTED.resourceUrlTemplate,
      extensionUrlTemplate: EXPECTED.extensionUrlTemplate,
    },
  );
  assert.ok(Object.isFrozen(config));

  const settings = getGallerySettingsCopy();
  assert.match(settings, /Open VSX Registry/u);
  assert.match(settings, /open-vsx\.org/u);
  assert.match(settings, /does not use the.*Microsoft Marketplace|not.*Microsoft Marketplace/iu);
  assert.match(settings, /Marketplace-only extensions are\s+unavailable/iu);

  const about = getGalleryAboutCopy();
  assert.match(about, /Open VSX Registry/u);
  assert.match(about, /open-vsx\.org\/vscode\/gallery/u);
  assert.match(about, /Built-in Densa ADE extension works without registry access/iu);
});

test("gallery detail and resource URLs resolve to Open VSX", () => {
  assert.equal(
    resolveGalleryItemUrl("rust-lang", "rust-analyzer"),
    "https://open-vsx.org/vscode/item?itemName=rust-lang.rust-analyzer",
  );
  assert.equal(
    resolveGalleryLatestUrl("rust-lang", "rust-analyzer"),
    "https://open-vsx.org/vscode/gallery/rust-lang/rust-analyzer/latest",
  );
  assert.equal(
    resolveGalleryResourceUrl("rust-lang", "rust-analyzer", "0.3.0", "package/README.md"),
    "https://open-vsx.org/vscode/unpkg/rust-lang/rust-analyzer/0.3.0/package/README.md",
  );
  assert.equal(parseGalleryExtensionId("rust-lang.rust-analyzer").id, "rust-lang.rust-analyzer");
  assert.throws(() => parseGalleryExtensionId("no-dot"), /publisher\.name/iu);
  assert.throws(() => parseGalleryExtensionId("a.b.c"), /publisher\.name/iu);
  assert.throws(() => parseGalleryExtensionId(""), /non-empty/iu);
  assert.throws(() => resolveGalleryItemUrl("", "x"), /non-empty|shape/iu);
  assert.throws(() => resolveGalleryResourceUrl("a", "b", "", "p"), /version/iu);
  assert.throws(() => resolveGalleryResourceUrl("a", "b", "1.0.0", ""), /path/iu);
});

test("search/install/update need a reachable registry; local ops work offline", () => {
  for (const operation of ["search", "install", "update"]) {
    const offline = resolveGalleryOperation(operation, "not-installed", "unreachable");
    assert.equal(offline.allowed, false, operation);
    assert.equal(offline.requiresRegistry, true, operation);
    assert.match(offline.guidance, /Open VSX Registry|unreachable/iu);
    const unknown = resolveGalleryOperation(operation, "not-installed", "unknown");
    assert.equal(unknown.allowed, false, operation);
    assert.match(unknown.guidance, /unknown/iu);
  }
  const outdated = resolveGalleryOperation("update", "outdated", "reachable");
  assert.equal(outdated.allowed, true);
  const current = resolveGalleryOperation("update", "installed-enabled", "reachable");
  assert.equal(current.allowed, false);
  assert.match(current.reason, /already-current/iu);

  const search = resolveGalleryOperation("search", "not-installed", "reachable");
  assert.equal(search.allowed, true);
  const install = resolveGalleryOperation("install", "not-installed", "reachable");
  assert.equal(install.allowed, true);
  const reinstall = resolveGalleryOperation("install", "installed-enabled", "reachable");
  assert.equal(reinstall.allowed, false);

  for (const reachability of ["reachable", "unreachable", "unknown"]) {
    const enable = resolveGalleryOperation("enable", "installed-disabled", reachability);
    assert.equal(enable.allowed, true, reachability);
    assert.equal(enable.requiresRegistry, false, reachability);
    const disable = resolveGalleryOperation("disable", "installed-enabled", reachability);
    assert.equal(disable.allowed, true, reachability);
    const uninstall = resolveGalleryOperation("uninstall", "installed-enabled", reachability);
    assert.equal(uninstall.allowed, true, reachability);
  }
  const enableMissing = resolveGalleryOperation("enable", "not-installed", "reachable");
  assert.equal(enableMissing.allowed, false);
  const uninstallMissing = resolveGalleryOperation("uninstall", "not-installed", "unreachable");
  assert.equal(uninstallMissing.allowed, false);
  assert.throws(
    () => resolveGalleryOperation("publish", "not-installed", "reachable"),
    /Unknown gallery operation/iu,
  );
});

test("failures are understandable and never block the editor", () => {
  for (const kind of [
    "registry-unreachable",
    "extension-not-found",
    "marketplace-only",
    "incompatible",
    "unknown",
  ]) {
    const failure = classifyGalleryFailure(kind, "probe detail");
    assert.equal(failure.kind, kind);
    assert.ok(failure.title.length > 0);
    assert.ok(failure.detail.length > 0);
    assert.ok(failure.nextAction.length > 0);
    assert.equal(failure.blocksEditor, false);
    assert.equal(failure.builtInUnaffected, true);
  }
  const offline = classifyGalleryFailure("registry-unreachable");
  assert.match(offline.detail, /open-vsx\.org\/vscode\/gallery/iu);
  assert.match(offline.nextAction, /reviewed \.vsix manually|Basic editing is unaffected/iu);

  const marketplaceOnly = describeMarketplaceOnlyUnavailable("ms-python.python");
  assert.equal(marketplaceOnly.kind, "marketplace-only");
  assert.match(marketplaceOnly.title, /not available from Open VSX Registry/iu);
  assert.match(marketplaceOnly.detail, /does not claim Microsoft Marketplace compatibility/iu);
  assert.match(marketplaceOnly.nextAction, /\.vsix manually/iu);
  assert.equal(marketplaceOnly.blocksEditor, false);
  assert.equal(marketplaceOnly.builtInUnaffected, true);
});

test("gallery model stays honest and built-in independent in every state", () => {
  const reachable = buildGalleryModel({ reachability: "reachable" });
  assert.equal(reachable.available, true);
  assert.match(reachable.statusTitle, /Open VSX Registry/u);
  assert.match(reachable.statusDetail, /open-vsx\.org\/vscode\/gallery/iu);
  assert.deepEqual(
    [...reachable.supportedOperations],
    ["search", "install", "enable", "disable", "uninstall", "update"],
  );
  assert.equal(reachable.builtInIndependent, true);
  assert.equal(reachable.blocksEditor, false);

  const unreachable = buildGalleryModel({
    reachability: "unreachable",
    reachabilityDetail: "ENOTFOUND",
  });
  assert.equal(unreachable.available, false);
  assert.match(unreachable.statusTitle, /unreachable/iu);
  assert.match(unreachable.statusDetail, /Installed extensions keep working/iu);
  assert.equal(unreachable.builtInIndependent, true);

  const unknown = buildGalleryModel({ reachability: "unknown" });
  assert.equal(unknown.available, false);
  assert.match(unknown.statusTitle, /unknown/iu);
  assert.match(unknown.statusDetail, /not reliably observed|optimistically/iu);
  assert.ok(
    !/resetAt|countdown|token|cost/iu.test(`${unknown.statusTitle} ${unknown.statusDetail}`),
  );

  assert.equal(EXTENSIONS_GALLERY_LIFECYCLE.createsNewAuthoritativeState, false);
  assert.equal(EXTENSIONS_GALLERY_LIFECYCLE.issuesCoreRequest, false);
  assert.equal(EXTENSIONS_GALLERY_LIFECYCLE.optimisticComplete, false);
  assert.equal(EXTENSIONS_GALLERY_LIFECYCLE.builtInIndependentOfRegistry, true);
  assert.throws(
    () => buildGalleryModel({ reachability: "online" }),
    /reachable, unreachable, or unknown/iu,
  );
});

test("built-in extension stays independent of registry availability", () => {
  const manifest = JSON.parse(readText("../apps/ide-extension/package.json"));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@densa-ade/protocol"]);

  const sources = ["index.ts", "extensions-gallery.ts"]
    .map((file) => readText(`../apps/ide-extension/src/${file}`))
    .join("\n");
  const forbidden = [
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/core(?:\/[^"']*)?["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*vs\/workbench[^"']*["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']vscode["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*sqlite[^"']*["']/iu,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/cli(?:\/[^"']*)?["']/u,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(sources), String(pattern));
  }
  assert.ok(
    !/\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?\.get\s*\(/u.test(sources),
    "gallery model performs no network I/O",
  );
  assert.ok(!/marketplace\.visualstudio\.com|marketplace\.microsoft\.com/u.test(sources));
});

test("gallery docs label Open VSX and disclaim Marketplace compatibility", () => {
  const doc = readText("../docs/open-vsx-gallery.md");
  assert.match(doc, /Open VSX Registry/u);
  assert.match(doc, /open-vsx\.org\/vscode\/gallery/u);
  assert.match(
    doc,
    /never claims Microsoft Marketplace|does not claim Microsoft Marketplace|not.*Microsoft Marketplace/iu,
  );
  assert.match(doc, /Marketplace-only/iu);
  assert.match(
    doc,
    /Built-in Densa ADE extension works without registry access|built-in.*independent/iu,
  );
});

test("ide:check gallery validation passes on this checkout", () => {
  const checked = runCheck();
  const galleryChecks = checked.checks.filter((entry) =>
    entry.name.toLowerCase().includes("gallery"),
  );
  assert.ok(galleryChecks.length >= 5, JSON.stringify(galleryChecks));
  assert.equal(checked.ok, true, JSON.stringify(checked.checks.filter((entry) => !entry.ok)));
});
