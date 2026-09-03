// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in Densa ADE extension scaffold (Phase 10 Milestone 0).
 *
 * Protocol-only IDE client boundary: this package may import
 * `@densa-ade/protocol` and nothing else from Densa ADE Core. It never imports
 * `@densa-ade/core`, SQLite repositories, daemon internals, or Code-OSS workbench
 * APIs. All project truth comes from Densa ADE Core over the versioned local
 * protocol; the IDE renders snapshots and sends validated requests.
 */

export {
  IDE_PROTOCOL_VERSION,
  assertCompatibleProtocol,
  createIdeConnectionOptions,
  type IdeCoreConnectionOptions,
} from "./connection.js";

export const EXTENSION_ID = "densa-labs.densa-ade" as const;

export const PRODUCT_BINDING = {
  applicationName: "densa-ade",
  nameShort: "Densa ADE",
  dataFolderName: "densa-ade",
  darwinBundleIdentifier: "labs.densa.ade",
} as const;

export const IDE_COMMAND_PALETTE_GROUP = "densa-ade" as const;

export const IDE_COMMANDS = [
  "densa-ade.showDashboard",
  "densa-ade.showRoadmap",
  "densa-ade.showMasterAgent",
  "densa-ade.startProject",
  "densa-ade.resumeProject",
] as const;

export type IdeCommand = (typeof IDE_COMMANDS)[number];

export const IDE_VIEWS = ["densa-ade.dashboard", "densa-ade.roadmap", "densa-ade.master"] as const;

export type IdeView = (typeof IDE_VIEWS)[number];

export interface IdeExtensionSummary {
  readonly extensionId: typeof EXTENSION_ID;
  readonly productBinding: typeof PRODUCT_BINDING;
  readonly commands: readonly IdeCommand[];
  readonly views: readonly IdeView[];
  readonly coreBoundary: "protocol-only";
}

export function describeExtension(): IdeExtensionSummary {
  return {
    extensionId: EXTENSION_ID,
    productBinding: PRODUCT_BINDING,
    commands: IDE_COMMANDS,
    views: IDE_VIEWS,
    coreBoundary: "protocol-only",
  };
}
