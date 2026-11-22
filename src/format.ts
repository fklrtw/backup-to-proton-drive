import * as path from 'node:path';

/**
 * Ordered binary unit suffixes supported by {@link formatBytes}.
 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;

/**
 * Extension-to-MIME-type lookup table used to populate Proton Drive file metadata.
 */
const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  '.7z': 'application/x-7z-compressed',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.bz2': 'application/x-bzip2',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eml': 'message/rfc822',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.heic': 'image/heic',
  '.html': 'text/html',
  '.ics': 'text/calendar',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.rtf': 'application/rtf',
  '.sqlite': 'application/vnd.sqlite3',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.vcf': 'text/vcard',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.xz': 'application/x-xz',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
  '.zst': 'application/zstd',
};

/**
 * Formats a byte count into a human-readable binary unit string (e.g., `"14.25 MB"`).
 *
 * Safely clamps values exceeding `EB`, preserves the sign for negative byte deltas,
 * and handles non-finite inputs cleanly without producing `"undefined"` or `"NaN"`.
 *
 * @param byteCount - Number of bytes to format.
 * @param decimalPlaces - Maximum number of fractional digits to display.
 * @returns Human-readable formatted string.
 */
export function formatBytes(byteCount: number, decimalPlaces = 2): string {
  if (!Number.isFinite(byteCount) || byteCount === 0) {
    return '0 B';
  }

  const isNegative = byteCount < 0;
  const absoluteBytes = Math.abs(byteCount);
  const kilobyteBase = 1024;
  const clampedDecimals = decimalPlaces < 0 ? 0 : decimalPlaces;

  if (absoluteBytes < 1) {
    const formattedSmallValue = parseFloat(absoluteBytes.toFixed(clampedDecimals));
    return `${isNegative ? '-' : ''}${formattedSmallValue} B`;
  }

  const rawUnitIndex = Math.floor(Math.log(absoluteBytes) / Math.log(kilobyteBase));
  const clampedUnitIndex = Math.min(Math.max(rawUnitIndex, 0), BYTE_UNITS.length - 1);
  const unitLabel = BYTE_UNITS[clampedUnitIndex] ?? 'B';
  const scaledValue = parseFloat((absoluteBytes / Math.pow(kilobyteBase, clampedUnitIndex)).toFixed(clampedDecimals));

  return `${isNegative ? '-' : ''}${scaledValue} ${unitLabel}`;
}

/**
 * Infers a standard MIME media type from a local file path's extension.
 *
 * @param filePath - Local file path or filename.
 * @returns Best-effort MIME type string, defaulting to `'application/octet-stream'`.
 */
export function inferMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return MEDIA_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/**
 * Builds the `x-pm-appversion` HTTP header required by Proton's API gateway for
 * external Drive SDK integrations (`external-drive-{name}@{semver}`).
 *
 * Proton's backend splits the portion before `@` on hyphens (`-`) into validated
 * product/section tokens and rejects headers with `HTTP 400, Code 2064: Invalid section name`
 * if `{name}` contains extra hyphens. Therefore `{name}` must use lowercase letters, digits,
 * or underscores only (`backuptoprotondrive`).
 *
 * @param applicationVersion - Semantic application version string (e.g., `"0.1.0"`).
 * @returns Validated `x-pm-appversion` header string.
 */
export function formatProtonAppVersionHeader(applicationVersion: string): string {
  return `external-drive-backuptoprotondrive@${applicationVersion}`;
}
