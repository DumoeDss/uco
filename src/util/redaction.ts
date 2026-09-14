const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /^(?:access[-_]?token|authorization|bearer|token|password|secret|api[-_]?key|android[-_]?(?:keystore|key[-_]?alias)[-_]?(?:base64|password))$/i;
const SENSITIVE_OPTION = /^-{1,2}(?:access[-_]?token|token|password|secret|api[-_]?key|android-(?:keystore-base64|keystore-password|key-alias-password))$/i;

/** Remove credential material without needing the original secret value. */
export function redactSensitiveValue(value: unknown): unknown {
  return visit(value, new WeakSet<object>());
}

export function redactSensitiveText(value: string): string {
  let result = value;
  result = result.replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s,;"']+/gi, `$1${REDACTED}`);
  result = result.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`);
  result = result.replace(/((?:[?&]|\b)(?:access_token|accessToken|token|api_key)=)[^&#\s"']+/gi, `$1${encodeURIComponent(REDACTED)}`);
  result = result.replace(/("(?:accessToken|access_token|authorization|token|password|secret|apiKey|api_key)"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`);
  result = result.replace(/((?:^|\s)-{1,2}(?:accessToken|access-token|token|password|secret|api-key|android-(?:keystore-base64|keystore-password|key-alias-password))(?:=|\s+))(?:(?!\s-{1,2})[^\r\n])+/gi, `$1${REDACTED}`);
  return result;
}

function visit(value: unknown, seen: WeakSet<object>, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(normalizeKey(key))) return REDACTED;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (typeof entry === 'string' && SENSITIVE_OPTION.test(entry.split('=', 1)[0] ?? entry)) {
        const equals = entry.indexOf('=');
        if (equals >= 0) {
          output.push(`${entry.slice(0, equals + 1)}${REDACTED}`);
        } else {
          output.push(entry);
          if (index + 1 < value.length) {
            output.push(REDACTED);
            index += 1;
          }
        }
      } else {
        output.push(visit(entry, seen));
      }
    }
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    output[entryKey] = visit(entryValue, seen, entryKey);
  }
  return output;
}

function normalizeKey(key: string): string {
  return key.replace(/[._\s]/g, '-');
}
