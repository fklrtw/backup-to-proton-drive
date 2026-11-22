import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Subset of Renovate's schedule-enabled feature configuration blocks
 * (such as `lockFileMaintenance` and `vulnerabilityAlerts`).
 */
interface RenovateScheduleFeatureConfiguration {
  enabled: boolean;
  schedule?: string[];
  labels?: string[];
}

/**
 * Subset of Renovate's `packageRules` entry properties used by this repository.
 */
interface RenovatePackageRule {
  description?: string;
  matchDatasources?: string[];
  matchManagers?: string[];
  matchDepTypes?: string[];
  matchUpdateTypes?: string[];
  matchPackageNames?: string[];
  minimumReleaseAge?: string;
  allowedVersions?: string;
  groupName?: string;
  labels?: string[];
}

/**
 * Typed representation of `.github/renovate.json` verified by the test suite.
 */
interface RenovateConfiguration {
  $schema?: string;
  description?: string;
  extends?: string[];
  dependencyDashboard?: boolean;
  automerge?: boolean;
  timezone?: string;
  schedule?: string[];
  labels?: string[];
  prConcurrentLimit?: number;
  prHourlyLimit?: number;
  lockFileMaintenance?: RenovateScheduleFeatureConfiguration;
  vulnerabilityAlerts?: RenovateScheduleFeatureConfiguration;
  'docker-compose'?: {
    enabled: boolean;
  };
  packageRules?: RenovatePackageRule[];
}

/**
 * Reads and parses the repository's `.github/renovate.json` configuration file.
 *
 * @returns Parsed Renovate configuration object.
 */
function loadRenovateConfiguration(): RenovateConfiguration {
  const renovateConfigurationPath = path.resolve('.github', 'renovate.json');
  const fileContents = fileSystem.readFileSync(renovateConfigurationPath, 'utf8');
  return JSON.parse(fileContents) as RenovateConfiguration;
}

/**
 * Converts a Renovate slash-delimited regular expression string (for example
 * `"/^@protontech\\//"`) into a standard JavaScript `RegExp` instance.
 *
 * @param packageNamePattern Slash-delimited regular expression string from Renovate config.
 * @returns Compiled `RegExp` matching the same package names as Renovate.
 */
function parseRenovatePackageNamePattern(packageNamePattern: string): RegExp {
  assert.ok(
    packageNamePattern.startsWith('/') && packageNamePattern.endsWith('/') && packageNamePattern.length > 2,
    `Expected slash-delimited Renovate regex pattern, received: ${packageNamePattern}`,
  );
  const patternBody = packageNamePattern.slice(1, -1);
  return new RegExp(patternBody);
}

describe('.github/renovate.json configuration', () => {
  it('defines expected top-level presets, schedule, security defaults, and disabled docker-compose manager', () => {
    const configuration = loadRenovateConfiguration();

    assert.equal(configuration.$schema, 'https://docs.renovatebot.com/renovate-schema.json');
    assert.ok(
      typeof configuration.description === 'string' && configuration.description.trim().length > 0,
      'Top-level Renovate configuration should include a human-readable description.',
    );
    assert.deepEqual(configuration.extends, [
      'config:recommended',
      ':pinAllExceptPeerDependencies',
      'docker:pinDigests',
      'helpers:pinGitHubActionDigests',
    ]);
    assert.equal(configuration.dependencyDashboard, true);
    assert.equal(configuration.automerge, false);
    assert.deepEqual(configuration.schedule, ['before 6am on monday']);
    assert.equal(configuration.lockFileMaintenance?.enabled, true);
    assert.equal(configuration.vulnerabilityAlerts?.enabled, true);
    assert.deepEqual(configuration.vulnerabilityAlerts?.schedule, ['at any time']);
    assert.equal(configuration['docker-compose']?.enabled, false);
  });

  it('documents every packageRule with a non-empty description', () => {
    const configuration = loadRenovateConfiguration();
    const packageRules = configuration.packageRules ?? [];

    assert.ok(packageRules.length >= 5, 'Expected all configured packageRules to be present.');

    for (const packageRule of packageRules) {
      assert.ok(
        typeof packageRule.description === 'string' && packageRule.description.trim().length > 0,
        `Every Renovate packageRule must include a non-empty description: ${JSON.stringify(packageRule)}`,
      );
    }
  });

  it('enforces a 3-day npm minimumReleaseAge cooldown', () => {
    const configuration = loadRenovateConfiguration();
    const packageRules = configuration.packageRules ?? [];

    const matchingRule = packageRules.find(
      (packageRule) =>
        packageRule.matchDatasources?.includes('npm') && packageRule.minimumReleaseAge === '3 days',
    );

    assert.ok(matchingRule, 'Expected a packageRule enforcing a 3-day minimumReleaseAge for npm.');
  });

  it('constrains Node.js runtime images, engines, and @types/node to Node 26.x', () => {
    const configuration = loadRenovateConfiguration();
    const packageRules = configuration.packageRules ?? [];

    const matchingRule = packageRules.find(
      (packageRule) => packageRule.allowedVersions === '>=26.0.0 <27.0.0',
    );

    assert.ok(matchingRule, 'Expected a packageRule restricting Node.js packages to >=26.0.0 <27.0.0.');
    for (const expectedPackageName of ['node', 'docker.io/library/node', '@types/node']) {
      assert.ok(
        matchingRule.matchPackageNames?.includes(expectedPackageName),
        `Expected Node 26 rule to include package name "${expectedPackageName}".`,
      );
    }
  });

  it('groups @protontech/* SDK and crypto updates together using a valid Renovate regex pattern', () => {
    const configuration = loadRenovateConfiguration();
    const packageRules = configuration.packageRules ?? [];

    const matchingRule = packageRules.find(
      (packageRule) => packageRule.groupName === 'Proton SDK & Crypto',
    );

    assert.ok(matchingRule, 'Expected a packageRule grouping @protontech/* updates.');
    assert.ok(matchingRule.matchDatasources?.includes('npm'));
    assert.ok(matchingRule.matchPackageNames && matchingRule.matchPackageNames.length === 1);

    const packageNamePattern = matchingRule.matchPackageNames[0];
    assert.ok(packageNamePattern !== undefined);
    const regularExpression = parseRenovatePackageNamePattern(packageNamePattern);

    assert.equal(regularExpression.test('@protontech/drive-sdk'), true);
    assert.equal(regularExpression.test('@protontech/crypto'), true);
    assert.equal(regularExpression.test('yaml'), false);
  });

  it('groups non-major npm devDependencies and GitHub Actions updates separately', () => {
    const configuration = loadRenovateConfiguration();
    const packageRules = configuration.packageRules ?? [];

    const developmentDependencyRule = packageRules.find(
      (packageRule) =>
        packageRule.matchManagers?.includes('npm') &&
        packageRule.matchDepTypes?.includes('devDependencies') &&
        packageRule.matchUpdateTypes?.includes('minor') &&
        packageRule.matchUpdateTypes?.includes('patch') &&
        typeof packageRule.groupName === 'string' &&
        packageRule.groupName.length > 0,
    );
    assert.ok(
      developmentDependencyRule,
      'Expected a packageRule grouping minor and patch npm devDependencies updates.',
    );

    const githubActionsRule = packageRules.find(
      (packageRule) =>
        packageRule.matchManagers?.includes('github-actions') &&
        typeof packageRule.groupName === 'string' &&
        packageRule.groupName.length > 0,
    );
    assert.ok(githubActionsRule, 'Expected a packageRule grouping github-actions updates.');
  });
});
