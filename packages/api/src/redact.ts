const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|secret|passphrase|password|token|webhook[-_]?url|authorization|cookie|cf-access-jwt-assertion)/i;

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

/**
 * Recursively clones an object and replaces values of sensitive credential keys with `[REDACTED]`.
 */
export function redactLogObject<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => redactLogObject(item)) as unknown as T;
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactLogObject(value);
      }
    }
    return out as T;
  }
  return input;
}
