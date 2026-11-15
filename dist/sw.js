// Bump the cache version when releasing changes to the offline files.
const cachePrefix = 'looplab-offline-';
const cacheName = cachePrefix + '44';
const scope = self.registration.scope;
const files = [
  'index.html', 'style.css', 'app.js', 'dance-stage.js', 'core.js', 'demo-song.js', 'audio.js', 'sounds.js',
  'mp3-worker.js', 'vendor/lame.min.js', 'science-chicken.svg',
  'science-chicken-blink.svg', 'manifest.webmanifest', 'app-icon-192.png', 'app-icon-512.png'
];
const appFiles = new Set(files.map(file => new URL(file, scope).href));
const shell = new URL('index.html', scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const responses = await Promise.all(files.map(async file => {
      const request = new Request(new URL(file, scope), { cache: 'reload', redirect: 'error' });
      const response = await fetch(file === 'index.html' ? new Request(scope, { cache: 'reload', redirect: 'error' }) : request);
      const html = response.headers.get('Content-Type')?.includes('text/html');
      if (!response.ok || (file === 'index.html'
        ? !html || !(await response.clone().text()).includes('id="primaryTransport"')
        : html)) throw new Error('Could not cache ' + file);
      return [request, response];
    }));
    await Promise.all(responses.map(([request, response]) => cache.put(request, response)));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(cachePrefix) && key !== cacheName).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const navigation = request.mode === 'navigate';
  const url = new URL(request.url);
  url.search = '';
  if (request.method !== 'GET' || (navigation
    ? url.href !== scope && url.href !== shell
    : !appFiles.has(url.href))) return;
  // Keep online requests subject to normal site access. Use the installed snapshot
  // only when a network request fails.
  event.respondWith(fetch(request).catch(async error => {
    const cache = await caches.open(cacheName);
    const response = await cache.match(navigation ? shell : url.href);
    if (!response) throw error;
    return response;
  }));
});
