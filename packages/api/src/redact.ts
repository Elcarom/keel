const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|secret|passphrase|password|token|webhook[-_]?url|authorization|cookie|cf-access-jwt-assertion)/i;

const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z\-_]{8,}/g,
  /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi
];

export const PINO_REDACT_PATHS: string[] = [
  "apiKey",
  "secret",
  "passphrase",
  "password",
  "token",
  "webhookUrl",
  "*.apiKey",
  "*.secret",
  "*.passphrase",
  "*.password",
  "*.token",
  "*.webhookUrl",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["cf-access-jwt-assertion"]'
];

export function redactStringSecrets(value: string): string {
  let out = value;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Recursively clones an object and replaces values of sensitive credential keys
 * or inline credential patterns with `[REDACTED]`.
 */
export function redactSecrets<T>(input: T): T {
  if (typeof input === "string") {
    return redactStringSecrets(input) as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item)) as unknown as T;
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactSecrets(value);
      }
    }
    return out as T;
  }
  return input;
}

export const redactLogObject = redactSecrets;
