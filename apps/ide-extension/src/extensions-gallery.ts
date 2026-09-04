// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE extension gallery experience (Phase 12 Milestone 1).
 *
 * The Code-OSS downstream uses the Open VSX Registry as its extension
 * gallery. Code-OSS ships no gallery by default; the proprietary Microsoft
 * Marketplace is never claimed. Gallery endpoints live in
 * `code-oss/product.overlay.json` and are applied at build time on top of
 * upstream `product.json` defaults.
 *
 * This module is pure and protocol-only:
 *
 * - it imports nothing from `@densa-ade/core`, `@densa-ade/cli`, SQLite, or
 *   `vscode` / `vs/workbench`. It performs no network I/O, spawns no
 *   processes, and never probes the registry. Caller-supplied reachability
 *   (`reachable` | `unreachable` | `unknown`) is rendered honestly; anything
 *   not reliably observed stays `unknown`;
 * - the built-in Densa ADE extension never depends on external registry
 *   availability. Gallery outages degrade to understandable guidance while
 *   the built-in extension, editor, and Core execution keep working;
 * - Marketplace-only extensions are reported as unavailable from Open VSX
 *   with an explicit reason. Densa ADE never claims Microsoft Marketplace
 *   compatibility and never rewrites a Marketplace-only id into a success.
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): gallery
 * behavior itself stays in the upstream workbench extension view driven by
 * `product.json`; this module supplies the registry constants, settings/about
 * labeling copy, detail/resource URL builders, operation gating, and failure
 * explanations the surfaces render. Zero workbench patches.
 */

/** Version of the gallery experience contract. */
export const EXTENSIONS_GALLERY_VERSION = 1 as const;

/** Stable registry identifier used in labels and diagnostics. */
export const EXTENSIONS_GALLERY_REGISTRY_ID = "open-vsx" as const;

/** Human-readable registry name shown in settings/about. */
export const EXTENSIONS_GALLERY_REGISTRY_LABEL = "Open VSX Registry" as const;

/** Registry home page linked from settings/about copy. */
export const EXTENSIONS_GALLERY_REGISTRY_HOME_URL = "https://open-vsx.org/" as const;

/** Search/query endpoint (Open VSX Marketplace-API adapter). */
export const EXTENSIONS_GALLERY_SERVICE_URL = "https://open-vsx.org/vscode/gallery" as const;

/** Extension detail-page base used for `?itemName={publisher}.{name}` links. */
export const EXTENSIONS_GALLERY_ITEM_URL = "https://open-vsx.org/vscode/item" as const;

/** Resource URL template for fetching extension assets. */
export const EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE =
  "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}" as const;

/** Latest-version URL template backing install/update. */
export const EXTENSIONS_GALLERY_EXTENSION_URL_TEMPLATE =
  "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest" as const;

/** How the registry was last observed. `unknown` means not reliably probed. */
export type GalleryRegistryReachability = "reachable" | "unreachable" | "unknown";

/** Lifecycle operations covered by the milestone acceptance criteria. */
export type GalleryOperationId =
  "search" | "install" | "enable" | "disable" | "uninstall" | "update";

/** Local install state of one extension. */
export type GalleryExtensionState =
  "not-installed" | "installed-enabled" | "installed-disabled" | "outdated";

/** Classified gallery failure kinds with stable messaging. */
export type GalleryFailureKind =
  "registry-unreachable" | "extension-not-found" | "marketplace-only" | "incompatible" | "unknown";

/** Build-time gallery endpoints mirrored from `product.overlay.json`. */
export interface GalleryConfig {
  readonly version: typeof EXTENSIONS_GALLERY_VERSION;
  readonly registryId: typeof EXTENSIONS_GALLERY_REGISTRY_ID;
  readonly registryLabel: typeof EXTENSIONS_GALLERY_REGISTRY_LABEL;
  readonly registryHomeUrl: typeof EXTENSIONS_GALLERY_REGISTRY_HOME_URL;
  readonly serviceUrl: typeof EXTENSIONS_GALLERY_SERVICE_URL;
  readonly itemUrl: typeof EXTENSIONS_GALLERY_ITEM_URL;
  readonly resourceUrlTemplate: typeof EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE;
  readonly extensionUrlTemplate: typeof EXTENSIONS_GALLERY_EXTENSION_URL_TEMPLATE;
}

/** Parsed `publisher.name` extension reference. */
export interface GalleryExtensionRef {
  readonly publisher: string;
  readonly name: string;
  readonly id: string;
}

/** Gating decision for one gallery operation. */
export interface GalleryOperationResolution {
  readonly operation: GalleryOperationId;
  readonly allowed: boolean;
  /** Stable machine-readable reason for UI copy and tests. */
  readonly reason: string;
  /** True when the operation needs the registry to be reachable. */
  readonly requiresRegistry: boolean;
  /** Understandable next step shown when `allowed` is false. */
  readonly guidance: string;
}

/** Understandable gallery failure with a clear next action. */
export interface GalleryFailure {
  readonly kind: GalleryFailureKind;
  readonly title: string;
  readonly detail: string;
  readonly nextAction: string;
  /** Always false: gallery trouble never blocks basic editing. */
  readonly blocksEditor: false;
  /** Always true: the built-in extension works without the registry. */
  readonly builtInUnaffected: true;
}

export interface GalleryModelInput {
  readonly reachability: GalleryRegistryReachability;
  readonly reachabilityDetail?: string;
}

export interface GalleryModel {
  readonly version: typeof EXTENSIONS_GALLERY_VERSION;
  readonly config: GalleryConfig;
  readonly registryLabel: typeof EXTENSIONS_GALLERY_REGISTRY_LABEL;
  readonly reachability: GalleryRegistryReachability;
  readonly available: boolean;
  readonly statusTitle: string;
  readonly statusDetail: string;
  readonly settingsCopy: string;
  readonly aboutCopy: string;
  readonly supportedOperations: readonly GalleryOperationId[];
  /** Always true: the built-in extension is independent of the registry. */
  readonly builtInIndependent: true;
  /** Always false: gallery state never blocks the editor. */
  readonly blocksEditor: false;
}

/**
 * Disposable-view lifecycle contract. The gallery is upstream workbench UI
 * driven by `product.json`; this model issues no Core request, creates no
 * project, and never becomes authoritative state.
 */
export const EXTENSIONS_GALLERY_LIFECYCLE = Object.freeze({
  /** Gallery outages dispose nothing but the transient error notice. */
  closeDisposes: "gallery-notice-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Gallery state never creates authoritative project state. */
  createsNewAuthoritativeState: false,
  /** Rendering gallery state issues no Core request. */
  issuesCoreRequest: false,
  /** The UI never marks install/update complete optimistically. */
  optimisticComplete: false,
  /** The built-in extension stays installed without the registry. */
  builtInIndependentOfRegistry: true,
});

const SUPPORTED_OPERATIONS: readonly GalleryOperationId[] = Object.freeze([
  "search",
  "install",
  "enable",
  "disable",
  "uninstall",
  "update",
]);

const OPERATION_TITLES: Readonly<Record<GalleryOperationId, string>> = Object.freeze({
  search: "Search extensions",
  install: "Install extension",
  enable: "Enable extension",
  disable: "Disable extension",
  uninstall: "Remove extension",
  update: "Update extension",
});

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRegistrySegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Canonical gallery endpoints. Frozen; mirrors `product.overlay.json`. */
export function getExtensionsGalleryConfig(): GalleryConfig {
  return Object.freeze({
    version: EXTENSIONS_GALLERY_VERSION,
    registryId: EXTENSIONS_GALLERY_REGISTRY_ID,
    registryLabel: EXTENSIONS_GALLERY_REGISTRY_LABEL,
    registryHomeUrl: EXTENSIONS_GALLERY_REGISTRY_HOME_URL,
    serviceUrl: EXTENSIONS_GALLERY_SERVICE_URL,
    itemUrl: EXTENSIONS_GALLERY_ITEM_URL,
    resourceUrlTemplate: EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE,
    extensionUrlTemplate: EXTENSIONS_GALLERY_EXTENSION_URL_TEMPLATE,
  });
}

/**
 * Parse a `publisher.name` extension id without guessing. Marketplace-only
 * availability is never inferred from the id shape; use
 * {@link describeMarketplaceOnlyUnavailable} when the registry reports it.
 */
export function parseGalleryExtensionId(id: unknown): GalleryExtensionRef {
  if (isNonEmptyText(id) !== true) {
    throw new Error("Extension id must be a non-empty publisher.name string.");
  }
  const trimmed = id.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0 || dot >= trimmed.length - 1 || trimmed.indexOf(".", dot + 1) !== -1) {
    throw new Error(`Extension id "${trimmed}" must have the shape publisher.name.`);
  }
  const publisher = trimmed.slice(0, dot);
  const name = trimmed.slice(dot + 1);
  if (isRegistrySegment(publisher) !== true || isRegistrySegment(name) !== true) {
    throw new Error(`Extension id "${trimmed}" contains an invalid publisher or name segment.`);
  }
  return Object.freeze({ publisher, name, id: `${publisher}.${name}` });
}

/** Detail-page URL for an extension (`itemUrl?itemName=publisher.name`). */
export function resolveGalleryItemUrl(publisher: string, name: string): string {
  const ref = parseGalleryExtensionId(`${publisher}.${name}`);
  return `${EXTENSIONS_GALLERY_ITEM_URL}?itemName=${encodeURIComponent(ref.id)}`;
}

/** Latest-version URL backing install/update. */
export function resolveGalleryLatestUrl(publisher: string, name: string): string {
  const ref = parseGalleryExtensionId(`${publisher}.${name}`);
  return `${EXTENSIONS_GALLERY_EXTENSION_URL_TEMPLATE.split("{publisher}")
    .join(encodeURIComponent(ref.publisher))
    .split("{name}")
    .join(encodeURIComponent(ref.name))}`;
}

/** Resource URL for one versioned asset path. */
export function resolveGalleryResourceUrl(
  publisher: string,
  name: string,
  version: string,
  path: string,
): string {
  const ref = parseGalleryExtensionId(`${publisher}.${name}`);
  if (isNonEmptyText(version) !== true) {
    throw new Error("Gallery resource version must be non-empty.");
  }
  if (isNonEmptyText(path) !== true) {
    throw new Error("Gallery resource path must be non-empty.");
  }
  const cleanVersion = version.trim();
  const cleanPath = path.trim().replace(/^\/+/, "");
  if (cleanPath.length === 0) {
    throw new Error("Gallery resource path must be non-empty.");
  }
  return EXTENSIONS_GALLERY_RESOURCE_URL_TEMPLATE.split("{publisher}")
    .join(encodeURIComponent(ref.publisher))
    .split("{name}")
    .join(encodeURIComponent(ref.name))
    .split("{version}")
    .join(encodeURIComponent(cleanVersion))
    .split("{path}")
    .join(
      cleanPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/"),
    );
}

/** Short registry label used wherever the source is named. */
export function getGalleryRegistryLabel(): typeof EXTENSIONS_GALLERY_REGISTRY_LABEL {
  return EXTENSIONS_GALLERY_REGISTRY_LABEL;
}

/** Settings copy that clearly labels the registry source. */
export function getGallerySettingsCopy(): string {
  return (
    `Extensions come from ${EXTENSIONS_GALLERY_REGISTRY_LABEL} ` +
    `(${EXTENSIONS_GALLERY_REGISTRY_HOME_URL}). Densa ADE does not use the ` +
    `proprietary Microsoft Marketplace, and Marketplace-only extensions are ` +
    `unavailable from this source.`
  );
}

/** About-dialog copy with the same source attribution. */
export function getGalleryAboutCopy(): string {
  return (
    `Extension gallery: ${EXTENSIONS_GALLERY_REGISTRY_LABEL} ` +
    `(${EXTENSIONS_GALLERY_SERVICE_URL}). ` +
    `Built-in Densa ADE extension works without registry access.`
  );
}

/**
 * Explain a Marketplace-only extension honestly. Never presented as
 * installable from Open VSX; points at manual `.vsix` review instead of
 * claiming compatibility.
 */
export function describeMarketplaceOnlyUnavailable(extensionId: string): GalleryFailure {
  const ref = parseGalleryExtensionId(extensionId);
  return Object.freeze({
    kind: "marketplace-only",
    title: `${ref.id} is not available from ${EXTENSIONS_GALLERY_REGISTRY_LABEL}`,
    detail:
      `${ref.id} is published to the proprietary Microsoft Marketplace only ` +
      `and is not mirrored on ${EXTENSIONS_GALLERY_REGISTRY_HOME_URL}. ` +
      `Densa ADE does not claim Microsoft Marketplace compatibility.`,
    nextAction:
      `Ask the publisher to publish to ${EXTENSIONS_GALLERY_REGISTRY_LABEL}, or ` +
      `review a publisher-provided .vsix manually before installing it. ` +
      `Details: ${resolveGalleryItemUrl(ref.publisher, ref.name)} shows only ` +
      `Open VSX results.`,
    blocksEditor: false,
    builtInUnaffected: true,
  });
}

/** Classify a gallery problem into understandable copy with a next action. */
export function classifyGalleryFailure(kind: GalleryFailureKind, detail?: string): GalleryFailure {
  const suffix = isNonEmptyText(detail) === true ? ` (${detail.trim()})` : "";
  switch (kind) {
    case "registry-unreachable":
      return Object.freeze({
        kind,
        title: `${EXTENSIONS_GALLERY_REGISTRY_LABEL} is unreachable`,
        detail:
          `Search, install, and update need ${EXTENSIONS_GALLERY_SERVICE_URL}${suffix}. ` +
          `Installed extensions and the built-in Densa ADE extension keep working.`,
        nextAction:
          "Check the network connection, retry shortly, or install a reviewed .vsix manually. Basic editing is unaffected.",
        blocksEditor: false,
        builtInUnaffected: true,
      });
    case "extension-not-found":
      return Object.freeze({
        kind,
        title: "Extension not found on Open VSX",
        detail: `No matching extension was returned by ${EXTENSIONS_GALLERY_SERVICE_URL}${suffix}. Names are publisher.name and case-sensitive in links.`,
        nextAction: `Verify the publisher.name spelling, open ${EXTENSIONS_GALLERY_REGISTRY_HOME_URL} to confirm it exists there, or follow the marketplace-only guidance when it is Marketplace-only.`,
        blocksEditor: false,
        builtInUnaffected: true,
      });
    case "marketplace-only":
      return Object.freeze({
        kind,
        title: `Extension is Marketplace-only and unavailable from ${EXTENSIONS_GALLERY_REGISTRY_LABEL}`,
        detail: `The extension is published to the proprietary Microsoft Marketplace only${suffix}. Densa ADE does not claim Microsoft Marketplace compatibility.`,
        nextAction: `Ask the publisher to publish to ${EXTENSIONS_GALLERY_REGISTRY_LABEL}, or review a publisher-provided .vsix manually before installing it.`,
        blocksEditor: false,
        builtInUnaffected: true,
      });
    case "incompatible":
      return Object.freeze({
        kind,
        title: "Extension version is incompatible with this Densa ADE build",
        detail: `The requested version cannot run against this build's vscode engine range${suffix}. Densa ADE reports incompatibility instead of installing it.`,
        nextAction:
          "Pick a compatible older version from the Open VSX version list, or update Densa ADE before retrying.",
        blocksEditor: false,
        builtInUnaffected: true,
      });
    case "unknown":
      return Object.freeze({
        kind,
        title: "Extension gallery state is unknown",
        detail: `Densa ADE could not reliably classify the gallery outcome${suffix}. Nothing is marked installed or updated optimistically.`,
        nextAction:
          "Retry once the registry is reachable and inspect the Extensions view detail before retrying a mutation.",
        blocksEditor: false,
        builtInUnaffected: true,
      });
  }
}

/**
 * Gate one gallery operation. Search/install/update need a reachable
 * registry; enable/disable/remove act on local state and stay available
 * offline. The built-in Densa ADE extension never requires the registry.
 */
export function resolveGalleryOperation(
  operation: GalleryOperationId,
  extensionState: GalleryExtensionState,
  reachability: GalleryRegistryReachability,
): GalleryOperationResolution {
  if ((SUPPORTED_OPERATIONS as readonly string[]).includes(operation) !== true) {
    throw new Error(`Unknown gallery operation ${String(operation)}.`);
  }
  const title = OPERATION_TITLES[operation];
  const registryRequired =
    operation === "search" || operation === "install" || operation === "update";
  if (registryRequired && reachability !== "reachable") {
    const observed =
      reachability === "unknown"
        ? "registry state is unknown (not reliably probed)"
        : "registry is unreachable";
    return Object.freeze({
      operation,
      allowed: false,
      reason: `registry-${reachability}`,
      requiresRegistry: true,
      guidance: `${title} needs ${EXTENSIONS_GALLERY_REGISTRY_LABEL}, and ${observed}. ${classifyGalleryFailure(reachability === "unknown" ? "unknown" : "registry-unreachable").nextAction}`,
    });
  }
  switch (operation) {
    case "search":
      return Object.freeze({
        operation,
        allowed: true,
        reason: "registry-reachable",
        requiresRegistry: true,
        guidance: `${title} queries ${EXTENSIONS_GALLERY_SERVICE_URL}.`,
      });
    case "install":
      if (extensionState !== "not-installed") {
        return Object.freeze({
          operation,
          allowed: false,
          reason: "already-installed",
          requiresRegistry: true,
          guidance:
            "The extension is already installed; use Update when a newer Open VSX version exists.",
        });
      }
      return Object.freeze({
        operation,
        allowed: true,
        reason: "registry-reachable",
        requiresRegistry: true,
        guidance: `${title} downloads the latest Open VSX version, then enable it.`,
      });
    case "update":
      if (extensionState !== "outdated") {
        return Object.freeze({
          operation,
          allowed: false,
          reason: "already-current",
          requiresRegistry: true,
          guidance:
            "No newer compatible Open VSX version is known; search shows the published versions.",
        });
      }
      return Object.freeze({
        operation,
        allowed: true,
        reason: "registry-reachable",
        requiresRegistry: true,
        guidance: `${title} downloads the newer compatible Open VSX version.`,
      });
    case "enable":
      if (extensionState === "not-installed") {
        return Object.freeze({
          operation,
          allowed: false,
          reason: "not-installed",
          requiresRegistry: false,
          guidance: "Install the extension from Open VSX before enabling it.",
        });
      }
      if (extensionState === "installed-enabled") {
        return Object.freeze({
          operation,
          allowed: false,
          reason: "already-enabled",
          requiresRegistry: false,
          guidance: "The extension is already enabled.",
        });
      }
      return Object.freeze({
        operation,
        allowed: true,
        reason: "local-state",
        requiresRegistry: false,
        guidance: `${title} acts on local state and works while the registry is unreachable.`,
      });
    case "disable":
      if (extensionState !== "installed-enabled") {
        return Object.freeze({
          operation,
          allowed: false,
          reason: "not-enabled",
          requiresRegistry: false,
          guidance: "Only an enabled extension can be disabled.",
        });
      }
      return Object.freeze({
        operation,
        allowed: true,
        reason: "local-state",
        requiresRegistry: false,
        guidance: `${title} acts on local state and works while the registry is unreachable.`,
      });
    case "uninstall":
      if (extensionState === "not-installed") {
        return Object.freeze({
          operation,
          allowed: false,
          reason: "not-installed",
          requiresRegistry: false,
          guidance: "The extension is not installed; nothing to remove.",
        });
      }
      return Object.freeze({
        operation,
        allowed: true,
        reason: "local-state",
        requiresRegistry: false,
        guidance: `${title} removes local files and works while the registry is unreachable. The built-in Densa ADE extension is unaffected.`,
      });
  }
}

/** Render the gallery surface state without inventing registry facts. */
export function buildGalleryModel(input: GalleryModelInput): GalleryModel {
  const reachability = input.reachability;
  if (
    reachability !== "reachable" &&
    reachability !== "unreachable" &&
    reachability !== "unknown"
  ) {
    throw new Error("Gallery reachability must be reachable, unreachable, or unknown.");
  }
  const available = reachability === "reachable";
  const statusTitle = available
    ? `Extensions from ${EXTENSIONS_GALLERY_REGISTRY_LABEL}`
    : reachability === "unreachable"
      ? `${EXTENSIONS_GALLERY_REGISTRY_LABEL} is unreachable`
      : `${EXTENSIONS_GALLERY_REGISTRY_LABEL} state is unknown`;
  const observedDetail =
    isNonEmptyText(input.reachabilityDetail) === true
      ? ` (${input.reachabilityDetail?.trim()})`
      : "";
  const statusDetail = available
    ? `Search, install, and update use ${EXTENSIONS_GALLERY_SERVICE_URL}${observedDetail}. Marketplace-only extensions stay unavailable; the built-in Densa ADE extension works regardless.`
    : reachability === "unreachable"
      ? `Search, install, and update need ${EXTENSIONS_GALLERY_SERVICE_URL}${observedDetail}. Installed extensions keep working; retry or install a reviewed .vsix manually.`
      : `Registry state was not reliably observed${observedDetail}. Nothing is marked installed or updated optimistically.`;
  return Object.freeze({
    version: EXTENSIONS_GALLERY_VERSION,
    config: getExtensionsGalleryConfig(),
    registryLabel: EXTENSIONS_GALLERY_REGISTRY_LABEL,
    reachability,
    available,
    statusTitle,
    statusDetail,
    settingsCopy: getGallerySettingsCopy(),
    aboutCopy: getGalleryAboutCopy(),
    supportedOperations: SUPPORTED_OPERATIONS,
    builtInIndependent: true,
    blocksEditor: false,
  });
}
