/**
 * Normalise any LinkedIn profile URL variant to https://www.linkedin.com/in/<slug>
 *   linkedin.com/in/jane-doe-123/?originalSubdomain=uk  -> https://www.linkedin.com/in/jane-doe-123
 *   https://uk.linkedin.com/in/jane-doe-123/details/    -> https://www.linkedin.com/in/jane-doe-123
 * Returns null when the input is not a personal profile URL.
 */
export function normalizeLinkedinUrl(input: unknown): string | null {
  if (!input) return null;
  let s = String(input).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/(in|pub)\/([^/?#]+)/i);
  if (!m) return null;
  let slug = m[2];
  try {
    slug = encodeURIComponent(decodeURIComponent(slug));
  } catch {
    /* keep as-is */
  }
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${slug}`;
}

export const profileSlug = (url: string) => {
  const last = url.split('/').pop() || url;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};
