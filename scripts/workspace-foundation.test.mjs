import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageNames = ["agent-sdk", "cli", "core", "protocol", "testing"];
const dependencySections = ["dependencies", "devDependencies", "peerDependencies"];
const forbiddenImportPattern =
  /\b(?:from\s+|import\s*(?:\(\s*)?)["'](?:vscode(?:[/"']|$)|vs\/|@vscode\/)/u;

function isEditorDependency(dependencyName) {
  return (
    dependencyName === "vscode" ||
    dependencyName === "code-oss" ||
    dependencyName.startsWith("@vscode/") ||
    dependencyName.startsWith("vs/")
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function listTypeScriptSources(directory) {
  const sources = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await listTypeScriptSources(path)));
    } else if (/\.(?:cts|mts|ts|tsx)$/u.test(entry.name)) {
      sources.push(path);
    }
  }
  return sources;
}

test("declares every Phase 0 workspace package", async () => {
  const rootPackage = await readJson(`${repositoryRoot}/package.json`);

  assert.deepEqual(rootPackage.workspaces, ["packages/*", "apps/*"]);

  for (const packageName of packageNames) {
    const manifest = await readJson(`${repositoryRoot}/packages/${packageName}/package.json`);
    assert.equal(manifest.name, `@densa-ade/${packageName}`);
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, "module");
  }
});

test("workspace manifests do not depend on editor APIs", async () => {
  for (const packageName of packageNames) {
    const manifest = await readJson(`${repositoryRoot}/packages/${packageName}/package.json`);

    for (const section of dependencySections) {
      const dependencies = manifest[section] ?? {};
      for (const dependencyName of Object.keys(dependencies)) {
        assert.equal(
          isEditorDependency(dependencyName),
          false,
          `${manifest.name} must not depend on ${dependencyName}`,
        );
      }
    }
  }
});

test("TypeScript sources do not import editor APIs", async () => {
  let nestedSourceWasInspected = false;
  for (const packageName of packageNames) {
    const sourceDirectory = `${repositoryRoot}/packages/${packageName}/src`;
    const sourceFiles = await listTypeScriptSources(sourceDirectory);

    for (const sourceFile of sourceFiles) {
      nestedSourceWasInspected ||= sourceFile.slice(sourceDirectory.length + 1).includes("/");
      const source = await readFile(sourceFile, "utf8");
      assert.doesNotMatch(source, forbiddenImportPattern);
    }
  }
  assert.equal(nestedSourceWasInspected, true, "the boundary check must cover nested source paths");
});
