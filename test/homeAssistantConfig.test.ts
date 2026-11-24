import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

import {
  DEFAULT_HOME_ASSISTANT_STATUS_URL,
  normalizeHomeAssistantPrefix,
  normalizeHomeAssistantStatusBaseUrl,
  renderHomeAssistantPackage,
  slugifyHomeAssistantName,
  writeHomeAssistantPackageFile,
} from '../src/homeAssistantConfig.ts';

interface ParsedHomeAssistantYaml {
  rest: Array<{
    resource: string;
    scan_interval: number;
    sensor: Array<{
      name: string;
      unique_id: string;
      value_template: string;
      json_attributes?: string[];
      device_class?: string;
    }>;
  }>;
  rest_command?: Record<
    string,
    {
      url: string;
      method: string;
      timeout: number;
      headers?: {
        authorization?: string;
      };
    }
  >;
  template: Array<{
    binary_sensor?: Array<{
      name: string;
      unique_id: string;
      state: string;
    }>;
    button?: Array<{
      name: string;
      unique_id: string;
      availability: string;
      press: Array<{
        action: string;
        target?: { entity_id?: string };
      }>;
    }>;
  }>;
  automation: Array<{
    id: string;
    alias: string;
    triggers: Array<{
      entity_id: string;
    }>;
    actions: Array<{
      action: string;
      data: {
        notification_id: string;
        title: string;
        message?: string;
      };
    }>;
  }>;
}

function parseGeneratedYaml(renderedYaml: string): ParsedHomeAssistantYaml {
  return parseYaml(renderedYaml, {
    customTags: [
      {
        tag: '!secret',
        resolve: (secretKey: string) => `__SECRET__:${secretKey}`,
      },
    ],
  }) as ParsedHomeAssistantYaml;
}

describe('homeAssistantConfig generator', () => {
  let temporaryRootDirectory = '';

  beforeEach(() => {
    temporaryRootDirectory = fileSystem.mkdtempSync(
      path.join(os.tmpdir(), 'proton-backup-ha-config-test-'),
    );
  });

  afterEach(() => {
    fileSystem.rmSync(temporaryRootDirectory, { recursive: true, force: true });
  });

  it('matches examples/home-assistant.yaml byte-for-byte with default options', () => {
    const checkedInExampleYaml = fileSystem.readFileSync(
      path.resolve('examples', 'home-assistant.yaml'),
      'utf8',
    );
    const defaultRenderedYaml = renderHomeAssistantPackage();
    assert.equal(defaultRenderedYaml, checkedInExampleYaml);
  });

  it('slugifies and normalizes prefixes and status URLs while rejecting invalid inputs', () => {
    assert.equal(slugifyHomeAssistantName('Paperless Proton Backup Status'), 'paperless_proton_backup_status');
    assert.equal(slugifyHomeAssistantName('NAS-01 Proton Backup Trigger'), 'nas_01_proton_backup_trigger');

    assert.deepEqual(normalizeHomeAssistantPrefix(undefined), {
      displayPrefix: undefined,
      slugPrefix: undefined,
    });
    assert.deepEqual(normalizeHomeAssistantPrefix('   '), {
      displayPrefix: undefined,
      slugPrefix: undefined,
    });
    assert.deepEqual(normalizeHomeAssistantPrefix('Paperless'), {
      displayPrefix: 'Paperless',
      slugPrefix: 'paperless',
    });
    assert.deepEqual(normalizeHomeAssistantPrefix('paperless_docs'), {
      displayPrefix: 'Paperless Docs',
      slugPrefix: 'paperless_docs',
    });
    assert.deepEqual(normalizeHomeAssistantPrefix('paperless-ngx'), {
      displayPrefix: 'Paperless-Ngx',
      slugPrefix: 'paperless_ngx',
    });
    assert.deepEqual(normalizeHomeAssistantPrefix('NAS-01'), {
      displayPrefix: 'NAS-01',
      slugPrefix: 'nas_01',
    });
    assert.deepEqual(normalizeHomeAssistantPrefix('Home Server'), {
      displayPrefix: 'Home Server',
      slugPrefix: 'home_server',
    });

    for (const invalidPrefix of ['Papërless', 'backup:one', '---', '___', 'foo/bar']) {
      assert.throws(() => normalizeHomeAssistantPrefix(invalidPrefix), /Invalid Home Assistant prefix/);
    }

    assert.equal(
      normalizeHomeAssistantStatusBaseUrl('http://192.168.1.50:9108///'),
      DEFAULT_HOME_ASSISTANT_STATUS_URL,
    );
    assert.equal(
      normalizeHomeAssistantStatusBaseUrl('https://backup.example.lan/proton/'),
      'https://backup.example.lan/proton',
    );
    assert.throws(() => normalizeHomeAssistantStatusBaseUrl(''), /cannot be empty/);
    assert.throws(() => normalizeHomeAssistantStatusBaseUrl('ftp://host:9108'), /Only http:\/\/ and https:\/\//);
    assert.throws(
      () => normalizeHomeAssistantStatusBaseUrl('http://user:pass@192.168.1.50:9108'),
      /must not embed username or password/,
    );
    assert.throws(
      () => normalizeHomeAssistantStatusBaseUrl('http://192.168.1.50:9108/?foo=bar'),
      /must not include query parameters or hash/,
    );
  });

  it('maintains entity slug invariants and isolates prefixed identifiers across setups', () => {
    const testCases: Array<{
      prefix?: string | undefined;
      expectedSlugBase: string;
      expectedDisplayBase: string;
      statusServerBaseUrl: string;
      scanIntervalSeconds: number;
    }> = [
      {
        prefix: undefined,
        expectedSlugBase: 'proton_backup',
        expectedDisplayBase: 'Proton Backup',
        statusServerBaseUrl: 'http://192.168.1.50:9108',
        scanIntervalSeconds: 300,
      },
      {
        prefix: 'Paperless',
        expectedSlugBase: 'paperless_proton_backup',
        expectedDisplayBase: 'Paperless Proton Backup',
        statusServerBaseUrl: 'http://10.0.0.20:9108/',
        scanIntervalSeconds: 120,
      },
      {
        prefix: 'paperless_docs',
        expectedSlugBase: 'paperless_docs_proton_backup',
        expectedDisplayBase: 'Paperless Docs Proton Backup',
        statusServerBaseUrl: 'https://backup.local/proton/',
        scanIntervalSeconds: 600,
      },
      {
        prefix: 'NAS-01',
        expectedSlugBase: 'nas_01_proton_backup',
        expectedDisplayBase: 'NAS-01 Proton Backup',
        statusServerBaseUrl: 'http://nas.local:9200',
        scanIntervalSeconds: 60,
      },
    ];

    for (const testCase of testCases) {
      const renderedYaml = renderHomeAssistantPackage({
        prefix: testCase.prefix,
        statusServerBaseUrl: testCase.statusServerBaseUrl,
        scanIntervalSeconds: testCase.scanIntervalSeconds,
      });
      const parsedYaml = parseGeneratedYaml(renderedYaml);

      const expectedStatusSensorId = `sensor.${testCase.expectedSlugBase}_status`;
      const expectedNeedsAttentionId = `binary_sensor.${testCase.expectedSlugBase}_needs_attention`;
      const expectedTriggerCommandKey = `${testCase.expectedSlugBase}_trigger`;
      const expectedBaseUrl = normalizeHomeAssistantStatusBaseUrl(testCase.statusServerBaseUrl);

      assert.equal(parsedYaml.rest[0]?.resource, `${expectedBaseUrl}/status`);
      assert.equal(parsedYaml.rest[0]?.scan_interval, testCase.scanIntervalSeconds);

      const statusSensor = parsedYaml.rest[0]?.sensor[0];
      const lastSuccessSensor = parsedYaml.rest[0]?.sensor[1];
      assert.ok(statusSensor);
      assert.ok(lastSuccessSensor);
      assert.equal(statusSensor.name, `${testCase.expectedDisplayBase} Status`);
      assert.equal(lastSuccessSensor.name, `${testCase.expectedDisplayBase} Last Success`);
      assert.ok(statusSensor.json_attributes?.includes('triggerEnabled'));

      const binarySensor = parsedYaml.template[0]?.binary_sensor?.[0];
      const triggerButton = parsedYaml.template[1]?.button?.[0];
      assert.ok(binarySensor);
      assert.ok(triggerButton);
      assert.equal(binarySensor.name, `${testCase.expectedDisplayBase} Needs Attention`);
      assert.equal(triggerButton.name, `${testCase.expectedDisplayBase} Trigger`);

      // Home Assistant slug invariant: every entity `name:` slugifies to its exact `unique_id`.
      for (const entityDefinition of [statusSensor, lastSuccessSensor, binarySensor, triggerButton]) {
        assert.equal(
          slugifyHomeAssistantName(entityDefinition.name),
          entityDefinition.unique_id,
        );
      }

      assert.ok(binarySensor.state.includes(expectedStatusSensorId));
      assert.ok(triggerButton.availability.includes(expectedStatusSensorId));
      assert.equal(triggerButton.press[0]?.action, `rest_command.${expectedTriggerCommandKey}`);
      assert.equal(triggerButton.press[2]?.target?.entity_id, expectedStatusSensorId);

      const restCommand = parsedYaml.rest_command?.[expectedTriggerCommandKey];
      assert.ok(restCommand);
      assert.equal(restCommand.url, `${expectedBaseUrl}/trigger`);
      assert.equal(
        restCommand.headers?.authorization,
        `__SECRET__:${testCase.expectedSlugBase}_trigger_authorization`,
      );

      assert.equal(parsedYaml.automation[0]?.id, `${testCase.expectedSlugBase}_problem_notify`);
      assert.equal(parsedYaml.automation[0]?.triggers[0]?.entity_id, expectedNeedsAttentionId);
      assert.equal(
        parsedYaml.automation[0]?.actions[0]?.data.notification_id,
        `${testCase.expectedSlugBase}_problem`,
      );
      assert.ok(parsedYaml.automation[0]?.actions[0]?.data.message?.includes(expectedStatusSensorId));
      assert.equal(parsedYaml.automation[1]?.id, `${testCase.expectedSlugBase}_problem_dismiss`);
      assert.equal(parsedYaml.automation[1]?.triggers[0]?.entity_id, expectedNeedsAttentionId);
      assert.equal(
        parsedYaml.automation[1]?.actions[0]?.data.notification_id,
        `${testCase.expectedSlugBase}_problem`,
      );

      // Verify commented Spook and Lovelace sections also use the exact prefixed IDs and leave zero unprefixed IDs.
      assert.ok(renderedYaml.includes(`issue_id: ${testCase.expectedSlugBase}_problem`));
      assert.ok(renderedYaml.includes(`entity: button.${testCase.expectedSlugBase}_trigger`));
      if (testCase.prefix !== undefined) {
        assert.equal(/(?<![a-z0-9_])proton_backup_/.test(renderedYaml), false);
      }
    }
  });

  it('supports --no-trigger and --allow-unauthenticated-trigger variants cleanly', () => {
    const noTriggerYaml = renderHomeAssistantPackage({
      prefix: 'Photos',
      includeTrigger: false,
    });
    const parsedNoTrigger = parseGeneratedYaml(noTriggerYaml);
    assert.equal(parsedNoTrigger.rest_command, undefined);
    assert.equal(parsedNoTrigger.template.length, 1);
    assert.equal(parsedNoTrigger.rest[0]?.sensor[0]?.json_attributes?.includes('triggerEnabled'), false);
    assert.equal(noTriggerYaml.includes('!secret'), false);
    assert.equal(noTriggerYaml.includes('button.photos_proton_backup_trigger'), false);

    const unauthenticatedTriggerYaml = renderHomeAssistantPackage({
      prefix: 'Photos',
      includeTrigger: true,
      allowUnauthenticatedTrigger: true,
    });
    const parsedUnauthenticated = parseGeneratedYaml(unauthenticatedTriggerYaml);
    assert.ok(parsedUnauthenticated.rest_command?.photos_proton_backup_trigger);
    assert.equal(parsedUnauthenticated.rest_command?.photos_proton_backup_trigger?.headers, undefined);
    assert.ok(parsedUnauthenticated.template[1]?.button?.[0]);
    assert.equal(unauthenticatedTriggerYaml.includes('!secret'), false);
    assert.ok(unauthenticatedTriggerYaml.includes('ALLOW_UNAUTHENTICATED_TRIGGER=true'));
  });

  it('writes and atomically overwrites generated package files including nested directories', () => {
    const nestedOutputPath = path.join(
      temporaryRootDirectory,
      'packages',
      'nested',
      'paperless_proton_backup.yaml',
    );
    const firstYaml = renderHomeAssistantPackage({ prefix: 'Paperless' });
    writeHomeAssistantPackageFile(nestedOutputPath, firstYaml);
    assert.equal(fileSystem.readFileSync(nestedOutputPath, 'utf8'), firstYaml);

    const secondYaml = renderHomeAssistantPackage({
      prefix: 'Paperless',
      statusServerBaseUrl: 'http://10.0.0.99:9108',
    });
    writeHomeAssistantPackageFile(nestedOutputPath, secondYaml);
    assert.equal(fileSystem.readFileSync(nestedOutputPath, 'utf8'), secondYaml);
  });
});
