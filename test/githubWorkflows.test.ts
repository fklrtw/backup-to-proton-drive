import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Subset of `package.json` metadata validated for exact pinning and ownership attribution.
 */
interface PackageManifest {
  version: string;
  author?: {
    name?: string;
    email?: string;
    url?: string;
  };
  contributors?: Array<{
    name?: string;
    email?: string;
    url?: string;
  }>;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Subset of `package-lock.json` validated to stay synchronized with pinned `package.json` specs.
 */
interface PackageLockManifest {
  version: string;
  packages?: Record<
    string,
    {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
}

/**
 * Extracts all `uses:` action references from a GitHub Actions workflow YAML file and verifies
 * that every action is pinned to a full 40-character hexadecimal commit SHA with a version comment.
 *
 * @param workflowFileName - File basename used in failure assertions.
 * @param workflowContent - Raw YAML file contents.
 * @returns Array of matched action reference strings.
 */
function assertAllActionsShaPinned(workflowFileName: string, workflowContent: string): string[] {
  const usesLines = workflowContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('uses:') || line.startsWith('- uses:'));

  assert.ok(usesLines.length > 0, `${workflowFileName} must declare at least one action step.`);

  const strictShaPinPattern =
    /uses:\s+[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+/;

  for (const usesLine of usesLines) {
    assert.match(
      usesLine,
      strictShaPinPattern,
      `${workflowFileName} contains unpinned or undocumented action reference: ${usesLine}`,
    );
  }

  return usesLines;
}

describe('GitHub security hardening, exact pinning, and attribution', () => {
  it('enforces SHA pinning, minimal permissions, persist-credentials=false, harden-runner audit mode, and npm ci --ignore-scripts in ci.yml', () => {
    const ciWorkflowContent = fileSystem.readFileSync(
      path.resolve('.github', 'workflows', 'ci.yml'),
      'utf8',
    );

    assert.match(ciWorkflowContent, /^permissions:\s*\{\}/m);
    assert.match(ciWorkflowContent, /egress-policy:\s*audit/);
    assert.doesNotMatch(ciWorkflowContent, /allowed-endpoints:/);
    assert.match(ciWorkflowContent, /persist-credentials:\s*false/);
    assert.match(ciWorkflowContent, /node-version-file:\s*\.node-version/);
    assert.match(ciWorkflowContent, /npm ci --ignore-scripts/);

    const usesLines = assertAllActionsShaPinned('ci.yml', ciWorkflowContent);
    const checkoutCount = usesLines.filter((line) => line.includes('actions/checkout@')).length;
    const persistFalseMatches = ciWorkflowContent.match(/persist-credentials:\s*false/g) ?? [];
    assert.equal(persistFalseMatches.length, checkoutCount);
  });

  it('gates docker-publish.yml behind verify, pins all actions, audits egress, and generates SLSA provenance', () => {
    const publishWorkflowContent = fileSystem.readFileSync(
      path.resolve('.github', 'workflows', 'docker-publish.yml'),
      'utf8',
    );

    assert.match(publishWorkflowContent, /^permissions:\s*\{\}/m);
    assert.match(publishWorkflowContent, /needs:\s*verify/);
    assert.match(publishWorkflowContent, /id-token:\s*write/);
    assert.match(publishWorkflowContent, /attestations:\s*write/);
    assert.match(publishWorkflowContent, /packages:\s*write/);
    assert.match(publishWorkflowContent, /actions\/attest-build-provenance@/);
    assert.match(publishWorkflowContent, /node-version-file:\s*\.node-version/);
    assert.match(publishWorkflowContent, /npm ci --ignore-scripts/);

    const hardenAuditMatches = publishWorkflowContent.match(/egress-policy:\s*audit/g) ?? [];
    assert.equal(hardenAuditMatches.length, 2, 'Both verify and build-and-push jobs must audit egress.');
    assert.doesNotMatch(publishWorkflowContent, /allowed-endpoints:/);

    const usesLines = assertAllActionsShaPinned('docker-publish.yml', publishWorkflowContent);
    const checkoutCount = usesLines.filter((line) => line.includes('actions/checkout@')).length;
    const persistFalseMatches = publishWorkflowContent.match(/persist-credentials:\s*false/g) ?? [];
    assert.equal(persistFalseMatches.length, checkoutCount);
  });

  it('pins Dockerfile base images by SHA256 digest, builds natively on $BUILDPLATFORM, and disables npm install scripts', () => {
    const dockerfileContent = fileSystem.readFileSync(path.resolve('Dockerfile'), 'utf8');

    assert.match(
      dockerfileContent,
      /FROM --platform=\$BUILDPLATFORM node:26-slim@sha256:[0-9a-f]{64} AS builder/,
    );
    assert.match(
      dockerfileContent,
      /FROM node:26-slim@sha256:[0-9a-f]{64} AS runtime/,
    );
    assert.match(dockerfileContent, /RUN npm ci --ignore-scripts/);
    assert.match(dockerfileContent, /org\.opencontainers\.image\.authors="fklrtw <fklrtw@gmail\.com>"/);
  });

  it('pins all npm dependencies exactly, aligns package-lock.json and .node-version, and includes GPL-3.0 LICENSE and attribution', () => {
    const packageManifest = JSON.parse(
      fileSystem.readFileSync(path.resolve('package.json'), 'utf8'),
    ) as PackageManifest;
    const packageLockManifest = JSON.parse(
      fileSystem.readFileSync(path.resolve('package-lock.json'), 'utf8'),
    ) as PackageLockManifest;

    assert.equal(packageManifest.version, '0.1.0');
    assert.equal(packageLockManifest.version, '0.1.0');
    assert.equal(packageManifest.license, 'GPL-3.0-or-later');
    assert.equal(packageManifest.author?.name, 'fklrtw');
    assert.equal(packageManifest.author?.email, 'fklrtw@gmail.com');

    const contributorNames = (packageManifest.contributors ?? []).map((contributor) => contributor.name);
    assert.ok(contributorNames.includes('fklrtw'));
    assert.ok(
      contributorNames.some((contributorName) => contributorName?.includes('Antigravity')),
      'Expected Antigravity contributor attribution in package.json.',
    );

    const exactVersionPattern = /^\d+\.\d+\.\d+$/;
    const lockRootPackage = packageLockManifest.packages?.[''];
    assert.ok(lockRootPackage);
    assert.equal(lockRootPackage.version, '0.1.0');

    for (const [dependencyName, versionSpecification] of Object.entries(
      packageManifest.dependencies ?? {},
    )) {
      assert.match(
        versionSpecification,
        exactVersionPattern,
        `Dependency ${dependencyName} must use an exact pinned version, received: ${versionSpecification}`,
      );
      assert.equal(lockRootPackage.dependencies?.[dependencyName], versionSpecification);
    }

    for (const [dependencyName, versionSpecification] of Object.entries(
      packageManifest.devDependencies ?? {},
    )) {
      assert.match(
        versionSpecification,
        exactVersionPattern,
        `DevDependency ${dependencyName} must use an exact pinned version, received: ${versionSpecification}`,
      );
      assert.equal(lockRootPackage.devDependencies?.[dependencyName], versionSpecification);
    }

    const nodeVersionText = fileSystem.readFileSync(path.resolve('.node-version'), 'utf8').trim();
    assert.match(nodeVersionText, /^26\.\d+\.\d+$/);

    const licenseText = fileSystem.readFileSync(path.resolve('LICENSE'), 'utf8');
    assert.match(licenseText, /GNU GENERAL PUBLIC LICENSE/);
    assert.match(licenseText, /Version 3, 29 June 2007/);
  });
});
