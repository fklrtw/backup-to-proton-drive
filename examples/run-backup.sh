#!/usr/bin/env bash
# ==============================================================================
# Script Name: run-backup.sh
# Description: Reference orchestration wrapper for backup-to-proton-drive.
#              Runs optional pre-sync export hooks (for example Paperless-ngx
#              document_exporter), records any pre-sync failure into status.json
#              via `report-failure`, and triggers the one-shot backup container.
# ==============================================================================
set -euo pipefail

# Host directory containing compose.yaml and config.yaml for backup-to-proton-drive
BACKUP_COMPOSE_DIRECTORY="/opt/backup-to-proton-drive"

# Optional host directory for a Paperless-ngx deployment when running a pre-sync export
PAPERLESS_COMPOSE_DIRECTORY="/opt/paperless"

# Tracks whether dry-run mode was requested so failure reporting does not mutate live status.json
IS_DRY_RUN=false
for cliArgument in "$@"; do
  if [[ "${cliArgument}" == "--dry-run" || "${cliArgument}" == "-n" ]]; then
    IS_DRY_RUN=true
    break
  fi
done

# Records an external pre-sync failure directly into /data/status.json so `status-server`
# and Home Assistant immediately report the failed step instead of waiting for the deadline.
report_external_failure() {
  local failureDescription="$1"
  if [[ "${IS_DRY_RUN}" == true ]]; then
    return
  fi

  docker compose -f "${BACKUP_COMPOSE_DIRECTORY}/compose.yaml" \
    run --rm --no-deps backup report-failure --message "${failureDescription}" || true
}

echo "Starting backup orchestration..."

# ------------------------------------------------------------------------------
# Optional Pre-Sync Hook Example: Paperless-ngx incremental export
# Uncomment the block below if exporting Paperless-ngx documents before syncing.
# ------------------------------------------------------------------------------
# echo "Exporting documents from Paperless-ngx..."
# if ! docker compose -f "${PAPERLESS_COMPOSE_DIRECTORY}/compose.yml" \
#   exec -T webserver document_exporter ../export \
#   --use-filename-format \
#   --compare-checksums \
#   --delete; then
#   report_external_failure "Pre-sync Paperless-ngx document_exporter failed"
#   exit 1
# fi

# ------------------------------------------------------------------------------
# Main Sync Step: invoke backup-to-proton-drive
# (`backup` writes /data/status.json automatically on start, success, warning, or error)
# ------------------------------------------------------------------------------
echo "Running backup-to-proton-drive..."
docker compose -f "${BACKUP_COMPOSE_DIRECTORY}/compose.yaml" \
  run --rm backup "$@"

echo "Backup orchestration completed successfully."
