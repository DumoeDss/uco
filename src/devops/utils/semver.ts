interface ParsedSemVer {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(version: string): ParsedSemVer | null {
  const match = SEMVER.exec(version);
  if (match === null) return null;

  const prerelease = match[4]?.split('.') ?? [];
  // Numeric prerelease identifiers must not contain leading zeroes. The
  // main expression already rejects empty and non-SemVer identifiers.
  if (prerelease.some((identifier) => /^\d+$/.test(identifier)
    && identifier.length > 1
    && identifier.startsWith('0'))) {
    return null;
  }

  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease,
  };
}

/** Returns true only for a complete SemVer 2.0.0 version. */
export function isValidVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const aValue = BigInt(a);
    const bValue = BigInt(b);
    return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns -1 if a < b, 0 if equivalent by SemVer precedence, 1 if a > b. */
function compareVersions(a: ParsedSemVer, b: ParsedSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }

  // A release has higher precedence than a prerelease. Build metadata is
  // intentionally absent from ParsedSemVer because SemVer ignores it.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) {
      if (left === right) return 0;
      return left === undefined ? -1 : 1;
    }
    const compared = compareIdentifiers(left, right);
    if (compared !== 0) return compared;
  }
  return 0;
}

/** Returns true if `latest` has strictly greater SemVer precedence. */
export function isNewerVersion(current: string, latest: string): boolean {
  const parsedCurrent = parseVersion(current);
  const parsedLatest = parseVersion(latest);
  if (parsedCurrent === null || parsedLatest === null) return false;
  return compareVersions(parsedCurrent, parsedLatest) < 0;
}
