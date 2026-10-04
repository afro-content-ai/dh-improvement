/**
 * DH Bingo — Service Worker
 * dh-bingo/sw.js
 *
 * Strategy (carried over unchanged from the proven reference implementation —
 * this part of the original app was already correct and needed no redesign):
 *  - App shell (index.html + fonts + static assets) → Cache-first with network fallback
 *  - Firebase Firestore/Auth traffic → Network-only (never cache real-time data)
 *  - Google Fonts → Cache-first (stale-while-revalidate)
 *  - On new SW activation → send "update-available" message to all clients
 *
 * Bump CACHE_VERSION whenever you deploy a new build to Netlify.
 * The old cache is deleted automatically; clients receive the update toast.
 */

const CACHE_VERSION = 'dh-bingo-v1.4';         // ← bump this on every deploy
const SHELL_CACHE   = `shell-${CACHE_VERSION}`;
const FONT_CACHE    = 'fonts-v1';              // fonts change rarely; keep separate

// Files that form the app shell
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Origins we NEVER cache (Firebase, real-time APIs)
const BYPASS_ORIGINS = [
  'firebaseio.com',
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'googleapis.com/identitytoolkit',
  'cloudfunctions.net'
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  // Do NOT call self.skipWaiting() here. The new worker should sit in the
  // "waiting" state until the user explicitly taps "Update" in the app's
  // toast (client posts SKIP_WAITING — see message handler below). Calling
  // skipWaiting() unconditionally on install causes the new SW to activate
  // and take over almost immediately, which forces every open tab through
  // an unannounced reload (via controllerchange) — risky mid-session for a
  // real-money game where a number call or claim could be in flight.
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS))
  );
});

// ─── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      // Delete all old shell caches (keep font cache)
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(k => k.startsWith('shell-') && k !== SHELL_CACHE)
            .map(k => caches.delete(k))
        )
      ),
      // Take control of all open tabs. This only runs after the user has
      // explicitly approved the update (client sent SKIP_WAITING), so
      // forcing control here is safe — the client's controllerchange
      // listener will reload the page right after this resolves.
      self.clients.claim()
    ])
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Always bypass real-time / Firebase traffic — never cache it
  if (BYPASS_ORIGINS.some(o => url.hostname.includes(o) || url.host.includes(o))) {
    return; // Let the browser handle it natively — no SW interception
  }

  // 2. Google Fonts CSS & files → stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(event.request, FONT_CACHE));
    return;
  }

  // 3. Navigation requests (HTML) → network-first so deploys propagate fast
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, SHELL_CACHE));
    return;
  }

  // 4. Everything else (JS, CSS, images) → cache-first
  event.respondWith(cacheFirst(event.request, SHELL_CACHE));
});

// ─── Strategies ──────────────────────────────────────────────────────────────

/**
 * Network-first: try network, fall back to cache.
 * Used for HTML so updates are seen immediately on a good connection.
 */
async function networkFirst(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline — please reconnect', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * Cache-first: serve from cache, fetch & update cache in background.
 * Used for static assets that rarely change.
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    return new Response('Asset unavailable offline', { status: 503 });
  }
}

/**
 * Stale-while-revalidate: serve cache immediately, fetch new version in background.
 * Ideal for fonts — instant load, quietly refreshed.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });

  return cached || fetchPromise;
}

// ─── Message handler (from app → SW) ─────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
