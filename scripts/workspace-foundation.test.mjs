import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

test("declares every Phase 0 workspace package", async () => {
  const rootPackage = await readJson(`${repositoryRoot}/package.json`);

  assert.deepEqual(rootPackage.workspaces, ["packages/*", "apps/*"]);

  for (const packageName of packageNames) {
    const manifest = await readJson(`${repositoryRoot}/packages/${packageName}/package.json`);
    assert.equal(manifest.name, `@densa/${packageName}`);
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
  for (const packageName of packageNames) {
    const sourceDirectory = `${repositoryRoot}/packages/${packageName}/src`;
    const sourceFiles = (await readdir(sourceDirectory)).filter((entry) => entry.endsWith(".ts"));

    for (const sourceFile of sourceFiles) {
      const source = await readFile(`${sourceDirectory}/${sourceFile}`, "utf8");
      assert.doesNotMatch(source, forbiddenImportPattern);
    }
  }
});
