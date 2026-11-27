/* Farreo - service worker del modo sin conexion.
 *
 * - Guarda la pagina /offline y los archivos estaticos de Next.js para que la
 *   app abra aunque no haya datos ni wifi.
 * - Si una pagina no carga por falta de red, redirige a /offline, donde se
 *   reproducen las canciones descargadas (guardadas en IndexedDB).
 * - No toca las peticiones al servidor de musica ni a otros dominios.
 */

const VERSION = "v1";
const SHELL_CACHE = `farreo-shell-${VERSION}`;
const STATIC_CACHE = `farreo-static-${VERSION}`;
const OFFLINE_URL = "/offline";
const NAV_TIMEOUT_MS = 9000;

const PRECACHE = [
  OFFLINE_URL,
  "/manifest.json",
  "/brand/farreo-app-icon-192.png",
  "/brand/farreo-f-favicon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("farreo-") && key !== SHELL_CACHE && key !== STATIC_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

const isStaticAsset = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  url.pathname.startsWith("/brand/") ||
  url.pathname === "/manifest.json";

const isOfflinePage = (url) => url.pathname === OFFLINE_URL || url.pathname === `${OFFLINE_URL}/`;

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function handleNavigation(request) {
  const url = new URL(request.url);
  const offlineCached = await caches.match(OFFLINE_URL, { ignoreSearch: true });

  try {
    // Sin copia guardada no hay alternativa: se espera a la red lo que haga falta.
    const network = fetch(request);
    const response = offlineCached ? await withTimeout(network, NAV_TIMEOUT_MS) : await network;
    if (isOfflinePage(url) && response.ok && response.type === "basic") {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(OFFLINE_URL, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    if (isOfflinePage(url)) {
      if (offlineCached) return offlineCached;
    } else if (offlineCached) {
      return Response.redirect(`${OFFLINE_URL}?sinconexion=1`, 302);
    }
    return new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
      "<body style='background:#171719;color:#fff;font-family:sans-serif;padding:2rem'>" +
      "<h1>Sin conexion</h1><p>Abre Farreo una vez con internet para activar el modo sin conexion.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});

// La pagina /offline envia la lista de recursos que ha usado para guardarlos,
// incluidos los que se cargaron antes de que el service worker tomara el control.
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "farreo-cache-urls" || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    const statics = await caches.open(STATIC_CACHE);
    await Promise.all(data.urls.map(async (raw) => {
      try {
        const url = new URL(raw, self.location.origin);
        if (url.origin !== self.location.origin) return;
        if (isOfflinePage(url)) {
          const res = await fetch(OFFLINE_URL, { cache: "no-store" });
          if (res.ok) await shell.put(OFFLINE_URL, res);
          return;
        }
        if (!isStaticAsset(url) || (await statics.match(url.href))) return;
        const res = await fetch(url.href);
        if (res.ok) await statics.put(url.href, res);
      } catch {
        /* sin red: se reintentara en la proxima visita */
      }
    }));
  })());
});
