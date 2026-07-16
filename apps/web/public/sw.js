/* global self, caches, URL, fetch */
const CACHE = "opc-ai-os-shell-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/", "/auth/login", "/manifest.webmanifest", "/icons/icon.svg"])));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).catch(() => {
      return caches.match(request).then((cached) => {
        return cached || caches.match("/");
      });
    })
  );
});
