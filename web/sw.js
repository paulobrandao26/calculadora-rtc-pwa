/* Service worker: guarda a "casca" do app para abrir rápido e funcionar sem internet.
 * Os cálculos (/svc/...) sempre vão para a rede. */
const VERSAO = 'rtc-v7';
const CASCA = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'sample-nfse.xml',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js'];

self.addEventListener('install', e => { e.waitUntil(caches.open(VERSAO).then(c => c.addAll(CASCA)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/svc/')) return;
  // rede primeiro (pega versão nova), cache se estiver sem internet
  e.respondWith(fetch(e.request).then(r => {
    const copia = r.clone(); caches.open(VERSAO).then(c => c.put(e.request, copia)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
