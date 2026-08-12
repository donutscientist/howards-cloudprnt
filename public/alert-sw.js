const CACHE = "howards-alert-v8";
const CONFIG_CACHE = "howards-alert-config";
const ASSETS = ["/alert-app.css", "/order-alarm.js", "/order-alarm.wav", "/alert-app.js", "/alert-icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("howards-alert-v") && key !== CACHE).map(key => caches.delete(key))))])));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/alert") || /^\/alert\d+/.test(url.pathname)) return;
  event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
});
self.addEventListener("message", event => {
  if (event.data?.type !== "configure-shop") return;
  const url = new URL(event.data.appUrl);
  if (url.origin !== self.location.origin || !/^\/alert\d+$/.test(url.pathname)) return;
  event.waitUntil(caches.open(CONFIG_CACHE).then(cache => cache.put(`/push-config/${Number(event.data.shop)}`, new Response(url.href))));
});
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = {}; }
  if (!data.title || !data.shop || !data.order) return;
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body || "New order", icon: "/alert-icon.svg", badge: "/alert-icon.svg", tag: `shop-${data.shop}-order-${data.order}`, data: { shop: Number(data.shop), order: String(data.order) } }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const { shop, order } = event.notification.data || {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).pathname === `/alert${shop}`);
    if (existing) { await existing.focus(); existing.postMessage({ type: "open-order", shop, order }); return; }
    const cache = await caches.open(CONFIG_CACHE);
    const saved = await cache.match(`/push-config/${shop}`);
    if (!saved) return;
    const url = new URL(await saved.text());
    url.searchParams.set("order", order);
    await self.clients.openWindow(url.href);
  })());
});
