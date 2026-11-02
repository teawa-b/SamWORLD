/**
 * "Send to WalkIn": a bookmarklet the person runs on a listing page in their own browser. It reads the
 * page they are looking at (images, srcsets, image URLs in the page's own data, captions saying
 * "floor plan") and opens WalkIn with that list. No logins, no bot traffic: it is the person's own view.
 * The future browser extension does the same thing and posts the same payload.
 */
function collect(walkinOrigin: string) {
  const seen: Record<string, { url: string; plan: boolean }> = {};
  const out: { url: string; plan: boolean }[] = [];
  const planRe = /floor\s?plan/i;
  // Zillow's floor-plan viewer: ?imxlb=f,0 means the image viewer is open on the floor-plans set.
  const planViewerOpen = /[?&]imxlb=f\b/i.test(location.search);
  const add = (raw: string | null | undefined, plan: boolean) => {
    if (!raw || raw.startsWith('data:')) return;
    let u: string;
    try {
      u = new URL(raw, location.href).href;
    } catch {
      return;
    }
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(u)) return;
    if (/logo|icon|sprite|avatar|badge|staticmap|maps\.google|agent|broker|headshot/i.test(u)) return;
    // Size variants of one picture share a base (e.g. Zillow's …/fp/<hash>-cc_ft_960.jpg).
    const k = u.replace(/[?#].*$/, '').replace(/-[a-z0-9_]+\.(jpe?g|png|webp)$/i, '');
    const prev = seen[k];
    if (prev) {
      if (plan) prev.plan = true;
      if (/1536|2048|uncropped|_max_|original/i.test(u) && !/1536|2048|uncropped|_max_|original/i.test(prev.url)) prev.url = u;
      return;
    }
    seen[k] = { url: u, plan };
    out.push(seen[k]);
  };
  const largest = (srcset: string | null) => {
    let best: string | null = null;
    let w = 0;
    for (const part of (srcset ?? '').split(',')) {
      const [url, d] = part.trim().split(/\s+/);
      const x = parseFloat(d) || 1;
      if (url && x >= w) [w, best] = [x, url];
    }
    return best;
  };
  document.querySelectorAll('img,source').forEach((el) => {
    const e = el as HTMLImageElement;
    const around = (e.closest('[aria-label],figure,li,button') as HTMLElement | null)?.textContent?.slice(0, 120) ?? '';
    const ctx = `${e.alt ?? ''} ${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''} ${around}`;
    const inViewer = !!e.closest('[role="dialog"],[aria-modal="true"]');
    const plan = planRe.test(ctx) || (planViewerOpen && inViewer);
    add(largest(e.getAttribute('srcset') ?? e.getAttribute('data-srcset')), plan);
    add(e.currentSrc || e.src || e.getAttribute('data-src'), plan);
  });
  document.querySelectorAll('script').forEach((s) => {
    let t = s.textContent ?? '';
    if (!t || t.length > 6e6) return;
    t = t.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    const re = /https?:\/\/[^"'\s\\)]+?\.(?:jpe?g|png|webp)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      // The JSON key this URL sits under (ignoring generic ones like "url"): "floorPlans": [...] → a plan.
      const keys = (t.slice(Math.max(0, m.index - 300), m.index).match(/"([A-Za-z_]+)"\s*:/g) ?? []).map((k) => k.replace(/[":\s]/g, '')).filter((k) => !/^(url|href|src|uri|link|jpeg|webp|width|height|mixedSources)$/i.test(k));
      add(m[0], /floor/i.test(keys[keys.length - 1] ?? '') || /floor.?plan/i.test(m[0]));
    }
  });
  if (!out.length) return void alert('WalkIn: no listing images found on this page.');
  const data = { title: document.title, pageUrl: location.href, images: out.slice(0, 120) };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  window.open(`${walkinOrigin}/#send=${encodeURIComponent(b64)}`, '_blank');
}

/** href for the draggable bookmark link. */
export function bookmarkletHref(): string {
  const origin = `${location.origin}${location.pathname.replace(/\/$/, '')}`;
  return `javascript:(${collect.toString()})(${JSON.stringify(origin)});void 0`;
}

export interface Collected {
  title: string;
  pageUrl: string;
  images: { url: string; plan: boolean }[];
}

/** Payload from the bookmarklet in this page's URL hash, if any (and clears it). */
export function takeCollected(): Collected | null {
  const m = location.hash.match(/^#send=(.+)$/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const json = decodeURIComponent(escape(atob(decodeURIComponent(m[1]))));
    const d = JSON.parse(json) as Collected;
    return Array.isArray(d.images) ? d : null;
  } catch {
    return null;
  }
}
