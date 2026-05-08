export function isAuthorizedCronRequest(request: Request): boolean {
  if (process.env.VERCEL_ENV !== "production") return true;

  const apiKey = request.headers.get("x-api-key");
  if (apiKey && apiKey === process.env.INTERNAL_API_KEY) return true;

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;

  // Backward-compatible fallback for deployments that have not configured
  // CRON_SECRET yet. Once CRON_SECRET exists, require the Bearer token.
  if (!cronSecret && request.headers.get("x-vercel-cron")) return true;

  return false;
}
