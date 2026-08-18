/**
 * The only `next` a magic LOGIN hand-off may carry (v1.28.0, CHECKIN):
 * `/subscription/{id}` plus a whitelist of query keys (`toast`, `checkin`)
 * with word-only values. The value arrives from the browser (untrusted) even
 * though the magic executor wrote it — never a host, never a scheme, never
 * an arbitrary path. Anything else → null (the home page, as before).
 */
export function safeHandoffNext(raw: string | null): string | null {
  if (!raw || raw.length > 200) return null;
  const [pathPart, query = ""] = raw.split("?", 2);
  if (!/^\/subscription\/[A-Za-z0-9_-]{1,64}$/.test(pathPart)) return null;
  const params = new URLSearchParams(query);
  const kept = new URLSearchParams();
  for (const key of ["toast", "checkin"]) {
    const value = params.get(key);
    if (value && /^[a-z_]{1,40}$/.test(value)) kept.set(key, value);
  }
  const qs = kept.toString();
  return qs ? `${pathPart}?${qs}` : pathPart;
}
