import * as fileSystem from 'node:fs';
import * as path from 'node:path';

import type { HomeAssistantConfigOptions } from './types.ts';

/** Default base URL for the `status-server` endpoint in generated Home Assistant configs. */
export const DEFAULT_HOME_ASSISTANT_STATUS_URL = 'http://192.168.1.50:9108';

/** Default polling interval (in seconds) for Home Assistant REST status sensors. */
export const DEFAULT_HOME_ASSISTANT_SCAN_INTERVAL_SECONDS = 300;

/** Minimum allowed Home Assistant REST sensor polling interval in seconds. */
export const MINIMUM_HOME_ASSISTANT_SCAN_INTERVAL_SECONDS = 10;

/** Maximum allowed Home Assistant REST sensor polling interval in seconds (24 hours). */
export const MAXIMUM_HOME_ASSISTANT_SCAN_INTERVAL_SECONDS = 86_400;

/**
 * Normalized display and slug representations derived from an optional `--prefix` flag.
 */
export interface NormalizedHomeAssistantPrefix {
  /** Human-readable title prefix prepended to entity display names, or `undefined` when unprefixed. */
  displayPrefix: string | undefined;
  /** Lowercase underscore slug prefix prepended to entity IDs, or `undefined` when unprefixed. */
  slugPrefix: string | undefined;
}

/**
 * Converts a Home Assistant entity display name into the canonical lowercase underscore slug
 * matching Home Assistant's entity ID generation from `name:`.
 *
 * @param rawName - Display name or prefix string.
 * @returns Lowercase alphanumeric/underscore slug without leading or trailing underscores.
 */
export function slugifyHomeAssistantName(rawName: string): string {
  return rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Validates and normalizes an optional `--prefix` value into matching display and entity-slug
 * prefixes so Home Assistant entity `name:` attributes always resolve to the exact entity IDs
 * referenced in templates, automations, and REST commands.
 *
 * @param rawPrefix - Raw `--prefix` CLI value (for example `"Paperless"`, `"paperless_docs"`, or `"NAS-01"`).
 * @returns Normalized display and slug prefixes.
 */
export function normalizeHomeAssistantPrefix(
  rawPrefix: string | undefined,
): NormalizedHomeAssistantPrefix {
  if (rawPrefix === undefined) {
    return {
      displayPrefix: undefined,
      slugPrefix: undefined,
    };
  }

  const trimmedPrefix = rawPrefix.trim();
  if (trimmedPrefix.length === 0) {
    return {
      displayPrefix: undefined,
      slugPrefix: undefined,
    };
  }

  if (!/^[A-Za-z0-9 _-]+$/.test(trimmedPrefix) || !/[A-Za-z0-9]/.test(trimmedPrefix)) {
    throw new Error(
      `Invalid Home Assistant prefix "${rawPrefix}". Use only ASCII letters, digits, spaces, hyphens ("-"), or underscores ("_") containing at least one letter or digit.`,
    );
  }

  const collapsedPrefix = trimmedPrefix.replace(/[_ ]+/g, ' ').replace(/^[ -]+|[ -]+$/g, '');
  if (!/[A-Za-z0-9]/.test(collapsedPrefix)) {
    throw new Error(
      `Invalid Home Assistant prefix "${rawPrefix}". Prefix must contain at least one ASCII letter or digit.`,
    );
  }

  // Preserve explicit user casing (such as "NAS-01" or "Paperless"); title-case all-lowercase inputs.
  const displayPrefix = /[A-Z]/.test(collapsedPrefix)
    ? collapsedPrefix
    : collapsedPrefix.replace(
        /[a-z0-9]+/g,
        (segment) => segment.charAt(0).toUpperCase() + segment.slice(1),
      );
  const slugPrefix = slugifyHomeAssistantName(displayPrefix);

  return {
    displayPrefix,
    slugPrefix,
  };
}

/**
 * Validates and normalizes a `status-server` base URL (`http://` or `https://`), removing any
 * trailing slash while rejecting embedded credentials, query strings, or fragments.
 *
 * @param rawStatusUrl - Raw `--status-url` CLI value.
 * @returns Normalized base URL string without trailing slash.
 */
export function normalizeHomeAssistantStatusBaseUrl(rawStatusUrl: string): string {
  const trimmedUrl = rawStatusUrl.trim();
  if (trimmedUrl.length === 0) {
    throw new Error('Status server URL cannot be empty.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    throw new Error(
      `Invalid status server URL "${rawStatusUrl}". Expected an http:// or https:// URL (for example "${DEFAULT_HOME_ASSISTANT_STATUS_URL}").`,
    );
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Unsupported URL scheme "${parsedUrl.protocol}" in "${rawStatusUrl}". Only http:// and https:// URLs are supported.`,
    );
  }

  if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
    throw new Error('Status server URL must not embed username or password credentials.');
  }

  if (parsedUrl.search.length > 0 || parsedUrl.hash.length > 0) {
    throw new Error('Status server URL must not include query parameters or hash fragments.');
  }

  const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, '');
  return `${parsedUrl.origin}${normalizedPathname}`;
}

/**
 * Validates that a Home Assistant REST polling interval is a finite integer within allowed bounds.
 *
 * @param scanIntervalSeconds - Candidate polling interval in seconds.
 * @returns Validated integer interval in seconds.
 */
function validateScanIntervalSeconds(scanIntervalSeconds: number): number {
  if (
    !Number.isInteger(scanIntervalSeconds) ||
    scanIntervalSeconds < MINIMUM_HOME_ASSISTANT_SCAN_INTERVAL_SECONDS ||
    scanIntervalSeconds > MAXIMUM_HOME_ASSISTANT_SCAN_INTERVAL_SECONDS
  ) {
    throw new Error(
      `Scan interval must be an integer between ${MINIMUM_HOME_ASSISTANT_SCAN_INTERVAL_SECONDS} and ${MAXIMUM_HOME_ASSISTANT_SCAN_INTERVAL_SECONDS} seconds (received ${scanIntervalSeconds}).`,
    );
  }

  return scanIntervalSeconds;
}

/**
 * Renders a complete, self-contained Home Assistant YAML package for monitoring (and optionally
 * triggering) a `backup-to-proton-drive status-server` instance. When called with default options,
 * the rendered output matches `examples/home-assistant.yaml` byte-for-byte.
 *
 * @param options - Optional prefix, endpoint URL, polling interval, and trigger configuration.
 * @returns Formatted Home Assistant YAML package ending with a single trailing newline.
 */
export function renderHomeAssistantPackage(
  options: Partial<HomeAssistantConfigOptions> = {},
): string {
  const { displayPrefix, slugPrefix } = normalizeHomeAssistantPrefix(options.prefix);
  const statusServerBaseUrl = normalizeHomeAssistantStatusBaseUrl(
    options.statusServerBaseUrl ?? DEFAULT_HOME_ASSISTANT_STATUS_URL,
  );
  const scanIntervalSeconds = validateScanIntervalSeconds(
    options.scanIntervalSeconds ?? DEFAULT_HOME_ASSISTANT_SCAN_INTERVAL_SECONDS,
  );
  const includeTrigger = options.includeTrigger ?? true;
  const allowUnauthenticatedTrigger = options.allowUnauthenticatedTrigger ?? false;

  const slugBase = slugPrefix ? `${slugPrefix}_proton_backup` : 'proton_backup';
  const displayBase = displayPrefix ? `${displayPrefix} Proton Backup` : 'Proton Backup';
  const driveBackupLabel = displayPrefix
    ? `${displayPrefix} Proton Drive Backup`
    : 'Proton Drive Backup';

  const statusSensorEntityId = `sensor.${slugBase}_status`;
  const lastSuccessSensorEntityId = `sensor.${slugBase}_last_success`;
  const needsAttentionBinarySensorEntityId = `binary_sensor.${slugBase}_needs_attention`;
  const triggerCommandName = `${slugBase}_trigger`;
  const triggerButtonEntityId = `button.${slugBase}_trigger`;
  const triggerSecretKey = `${slugBase}_trigger_authorization`;
  const problemIdentifier = `${slugBase}_problem`;

  const lines: string[] = [
    '# Home Assistant Package Reference for monitoring and triggering `backup-to-proton-drive status-server`.',
    '#',
    '# Setup:',
    '# 1. Start the companion `status` service from compose.yaml (`docker compose up -d`).',
  ];

  if (includeTrigger) {
    const authenticationEnvHint = allowUnauthenticatedTrigger
      ? '`ALLOW_UNAUTHENTICATED_TRIGGER=true`'
      : '`STATUS_TRIGGER_TOKEN_FILE`';
    lines.push(
      `#    To enable the on-demand trigger button (\`${triggerButtonEntityId}\`), also configure`,
      `#    \`STATUS_TRIGGER_FILE\` + ${authenticationEnvHint} on \`status\` and install`,
      '#    `systemd/backup-to-proton-drive-trigger.path` on the backup host.',
    );
  }

  lines.push(
    `# 2. Verify the \`status-server\` URL below (${statusServerBaseUrl}) matches the LAN IP or hostname of this backup host.`,
  );

  let nextSetupStepNumber = 3;
  if (includeTrigger && !allowUnauthenticatedTrigger) {
    lines.push(
      `# ${nextSetupStepNumber}. Add the matching trigger bearer token to Home Assistant \`secrets.yaml\` (required for \`POST /trigger\`):`,
      `#      ${triggerSecretKey}: "Bearer <contents-of-status_trigger_token.txt>"`,
    );
    nextSetupStepNumber += 1;
  }

  const topLevelBlocksLabel = includeTrigger
    ? '`rest:`, `rest_command:`, `template:`, and `automation:` blocks'
    : '`rest:`, `template:`, and `automation:` blocks';
  lines.push(
    `# ${nextSetupStepNumber}. Include this file as a package in Home Assistant \`configuration.yaml\`:`,
    '#      homeassistant:',
    '#        packages:',
    `#          ${slugBase}: !include packages/${slugBase}.yaml`,
    `#    (or merge the top-level ${topLevelBlocksLabel} directly).`,
  );
  nextSetupStepNumber += 1;

  const integrationsRestartLabel = includeTrigger ? '`rest:` or `rest_command:`' : '`rest:`';
  lines.push(
    `# ${nextSetupStepNumber}. Restart Home Assistant completely (adding new ${integrationsRestartLabel} integrations requires a`,
    '#    full restart; YAML reloads alone will not register them).',
    '#',
    '# Multiple setups / naming note:',
    '# - Regenerate a prefixed package cleanly without ID collisions across multiple backup hosts:',
    '#     backup-to-proton-drive home-assistant-config --prefix <name> --status-url <url>',
    '# - Home Assistant derives default entity IDs from `name:` (not `unique_id:`). If you manually rename',
    `#   entities below, update \`${statusSensorEntityId}\`,`,
    includeTrigger
      ? `#   \`${needsAttentionBinarySensorEntityId}\`, and \`${triggerButtonEntityId}\` throughout this`
      : `#   and \`${needsAttentionBinarySensorEntityId}\` throughout this`,
    '#   file to match.',
    '',
    'rest:',
    `  - resource: ${statusServerBaseUrl}/status`,
    `    scan_interval: ${scanIntervalSeconds}`,
    '    timeout: 15',
    '    sensor:',
    '      # Home Assistant supports `json_attributes:` on `rest:` `sensor:` entities (not `binary_sensor:`).',
    '      # Exposes `status` (`ok` / `warning` / `error` / `never_run`) plus compact summary attributes.',
    includeTrigger
      ? '      # Note: `ageHours`, `checkedAt`, and `triggerCooldownRemainingSeconds` are intentionally omitted'
      : '      # Note: `ageHours` and `checkedAt` are intentionally omitted from json_attributes because',
    includeTrigger
      ? '      # from json_attributes because they change over time without state transitions and would'
      : '      # they change on every poll and would unnecessarily inflate the Home Assistant recorder database.',
    ...(includeTrigger
      ? ['      # unnecessarily inflate the Home Assistant recorder database.']
      : []),
    `      - name: "${displayBase} Status"`,
    `        unique_id: ${slugBase}_status`,
    '        value_template: "{{ value_json.status }}"',
    '        json_attributes:',
    '          - problem',
    '          - healthy',
    '          - overdue',
    '          - running',
    '          - lastRunAt',
    '          - lastSuccessAt',
    '          - durationSeconds',
    '          - errorMessage',
    '          - summary',
  );

  if (includeTrigger) {
    lines.push(
      '          - triggerEnabled',
      '          - triggerAvailable',
      '          - triggerPending',
      '          - triggerAvailableAt',
    );
  }

  lines.push(
    '',
    '      # Timestamp sensor showing when the last backup with complete local uploads finished.',
    `      - name: "${displayBase} Last Success"`,
    `        unique_id: ${slugBase}_last_success`,
    '        device_class: timestamp',
    '        value_template: "{{ value_json.lastSuccessAt if value_json.lastSuccessAt else None }}"',
  );

  if (includeTrigger) {
    lines.push(
      '',
      'rest_command:',
      allowUnauthenticatedTrigger
        ? `  # Unauthenticated on-demand trigger command invoked by \`${triggerButtonEntityId}\` or automations.`
        : `  # Authenticated on-demand trigger command invoked by \`${triggerButtonEntityId}\` or automations.`,
      ...(allowUnauthenticatedTrigger
        ? ['  # Assumes `ALLOW_UNAUTHENTICATED_TRIGGER=true` is configured on `status-server`.']
        : ['  # Omit `headers:` only if `ALLOW_UNAUTHENTICATED_TRIGGER=true` is configured on `status-server`.']),
      `  ${triggerCommandName}:`,
      `    url: ${statusServerBaseUrl}/trigger`,
      '    method: POST',
      '    timeout: 15',
    );

    if (!allowUnauthenticatedTrigger) {
      lines.push('    headers:', `      authorization: !secret ${triggerSecretKey}`);
    }
  }

  lines.push(
    '',
    'template:',
    '  - binary_sensor:',
    '      # Exposes a single `device_class: problem` indicator (`on` = Problem, `off` = Clear).',
    '      # Trips on errors, partial trash warnings, overdue backups (`problem: true`), OR if the',
    '      # status endpoint becomes unreachable (`unavailable` / `unknown`).',
    `      - name: "${displayBase} Needs Attention"`,
    `        unique_id: ${slugBase}_needs_attention`,
    '        device_class: problem',
    '        state: >',
    '          {{',
    `            not is_state('${statusSensorEntityId}', 'ok')`,
    `            or state_attr('${statusSensorEntityId}', 'problem') == true`,
    '          }}',
  );

  if (includeTrigger) {
    lines.push(
      '',
      '  - button:',
      '      # Exposes a dashboard/automation button to trigger an on-demand backup via `POST /trigger`.',
      '      # Automatically becomes `unavailable` while `status-server` is unreachable, trigger is disabled,',
      '      # a backup is running, a trigger request is pending, or the cooldown period has not elapsed.',
      '      # Referencing `now()` allows Home Assistant to re-enable the button automatically once',
      '      # `triggerAvailableAt` passes, even before the next scheduled `rest:` poll.',
      `      - name: "${displayBase} Trigger"`,
      `        unique_id: ${slugBase}_trigger`,
      '        icon: mdi:cloud-upload',
      '        availability: >',
      `          {% set backup_state = states('${statusSensorEntityId}') %}`,
      "          {% if backup_state in ['unavailable', 'unknown'] %}",
      '            false',
      `          {% elif state_attr('${statusSensorEntityId}', 'triggerEnabled') != true %}`,
      '            false',
      `          {% elif state_attr('${statusSensorEntityId}', 'running') == true or state_attr('${statusSensorEntityId}', 'triggerPending') == true %}`,
      '            false',
      `          {% elif state_attr('${statusSensorEntityId}', 'triggerAvailable') == true %}`,
      '            true',
      '          {% else %}',
      `            {% set available_at = state_attr('${statusSensorEntityId}', 'triggerAvailableAt') %}`,
      '            {{ available_at is string and available_at | length > 0 and now() >= as_datetime(available_at) }}',
      '          {% endif %}',
      '        press:',
      `          - action: rest_command.${triggerCommandName}`,
      '            response_variable: trigger_response',
      '          - delay:',
      '              seconds: 2',
      '          - action: homeassistant.update_entity',
      '            target:',
      `              entity_id: ${statusSensorEntityId}`,
    );
  }

  lines.push(
    '',
    'automation:',
    `  - id: ${slugBase}_problem_notify`,
    `    alias: "${displayBase}: Notify when backup needs attention"`,
    '    mode: single',
    '    triggers:',
    '      # Wait 10 minutes before alerting so host reboots or brief container updates do not false-trigger.',
    '      - trigger: state',
    `        entity_id: ${needsAttentionBinarySensorEntityId}`,
    '        to: "on"',
    '        for:',
    '          minutes: 10',
    '    actions:',
    '      - action: persistent_notification.create',
    '        data:',
    `          notification_id: ${problemIdentifier}`,
    `          title: "${driveBackupLabel} Needs Attention"`,
    '          message: >',
    `            {% set backup_state = states('${statusSensorEntityId}') %}`,
    `            {% set is_overdue = state_attr('${statusSensorEntityId}', 'overdue') %}`,
    `            {% set last_success = state_attr('${statusSensorEntityId}', 'lastSuccessAt') %}`,
    `            {% set error_detail = state_attr('${statusSensorEntityId}', 'errorMessage') %}`,
    "            {% if backup_state in ['unavailable', 'unknown'] %}",
    '            Backup status endpoint is unreachable (`{{ backup_state }}`).',
    '            {% else %}',
    '            Status: `{{ backup_state }}` | Overdue: `{{ is_overdue }}`',
    "            Last success: {{ last_success or 'never' }}",
    '            {% if error_detail %}Error: {{ error_detail }}{% endif %}',
    '            {% endif %}',
    '      # Optional (requires Spook custom integration): create a native Home Assistant Repairs issue',
    '      # under Settings -> System -> Repairs (persists across restarts until dismissed below):',
    '      # - action: repairs.create',
    '      #   data:',
    '      #     domain: spook',
    `      #     issue_id: ${problemIdentifier}`,
    `      #     title: "${driveBackupLabel} Needs Attention"`,
    '      #     description: >',
    `      #       Status: {{ states('${statusSensorEntityId}') }}`,
    `      #       (overdue={{ state_attr('${statusSensorEntityId}', 'overdue') }},`,
    `      #       lastSuccessAt={{ state_attr('${statusSensorEntityId}', 'lastSuccessAt') or 'never' }})`,
    `      #       {{ state_attr('${statusSensorEntityId}', 'errorMessage') or '' }}`,
    '      #     severity: error',
    '      #     persistent: true',
    '      #',
    '      # Optional: also push a mobile notification via the Home Assistant Companion App:',
    '      # - action: notify.mobile_app_your_phone',
    '      #   data:',
    `      #     title: "${driveBackupLabel} Needs Attention"`,
    '      #     message: >',
    `      #       Status: {{ states('${statusSensorEntityId}') }}`,
    `      #       {{ state_attr('${statusSensorEntityId}', 'errorMessage') or '' }}`,
    '',
    `  - id: ${slugBase}_problem_dismiss`,
    `    alias: "${displayBase}: Dismiss notification when healthy"`,
    '    mode: single',
    '    triggers:',
    '      - trigger: state',
    `        entity_id: ${needsAttentionBinarySensorEntityId}`,
    '        to: "off"',
    '    actions:',
    '      - action: persistent_notification.dismiss',
    '        data:',
    `          notification_id: ${problemIdentifier}`,
    '      # Optional (if using Spook `repairs.create` above): auto-remove the Repairs issue when healthy:',
    '      # - action: repairs.remove',
    '      #   data:',
    '      #     domain: spook',
    `      #     issue_id: ${problemIdentifier}`,
    '',
    '# Optional Lovelace Maintenance Dashboard Card (hidden automatically when healthy):',
    '#',
    '# type: conditional',
    '# conditions:',
    '#   - condition: state',
    `#     entity: ${needsAttentionBinarySensorEntityId}`,
    '#     state: "on"',
    '# card:',
    '#   type: entities',
    '#   title: "Backup Alerts"',
    '#   entities:',
    `#     - entity: ${needsAttentionBinarySensorEntityId}`,
    `#       name: "${driveBackupLabel}"`,
    `#     - entity: ${statusSensorEntityId}`,
    '#       name: "Backup Status"',
    `#     - entity: ${lastSuccessSensorEntityId}`,
    '#       name: "Last Successful Backup"',
  );

  if (includeTrigger) {
    lines.push(`#     - entity: ${triggerButtonEntityId}`, '#       name: "Trigger Backup Now"');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Atomically writes a rendered Home Assistant package YAML file (`0644`), creating missing
 * parent directories if necessary.
 *
 * @param outputFilePath - Target file path to write or overwrite.
 * @param renderedYamlContent - Rendered YAML package content.
 */
export function writeHomeAssistantPackageFile(
  outputFilePath: string,
  renderedYamlContent: string,
): void {
  const targetDirectory = path.dirname(outputFilePath);
  fileSystem.mkdirSync(targetDirectory, { recursive: true });

  const temporaryFilePath = path.join(
    targetDirectory,
    `.home-assistant.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    fileSystem.writeFileSync(temporaryFilePath, renderedYamlContent, {
      encoding: 'utf8',
      mode: 0o644,
    });
    fileSystem.renameSync(temporaryFilePath, outputFilePath);
  } catch (writeError) {
    try {
      if (fileSystem.existsSync(temporaryFilePath)) {
        fileSystem.unlinkSync(temporaryFilePath);
      }
    } catch {
      // Best-effort cleanup of failed temporary file write.
    }
    throw writeError;
  }
}
