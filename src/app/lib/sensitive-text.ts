function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?[redacted]";
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}

export function sanitizeOperationalText(
  value: string | null | undefined,
  maxLength = 2000,
): string | null {
  if (!value) return value ?? null;
  const redacted = value
    .replace(/https?:\/\/[^\s"'<>)]*/gi, redactUrl)
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, "Basic [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|x-api-key|x-shopify-access-token|token|access_token|api_key|password|secret|client_secret)(["'\s:=]+)([^"',\s}]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\b(shpat_|shpua_|sk_|rk_)[A-Za-z0-9_-]+/g, "$1[redacted]");

  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}

export function sanitizeOperationalTextExcerpt(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const sanitized = sanitizeOperationalText(value, Math.max(maxLength + 1, 1));
  const collapsed = sanitized?.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(maxLength - 1, 0))}…`;
}
