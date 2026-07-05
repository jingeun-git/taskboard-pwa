const CACHE = 'taskboard-shell-v4';
const SHELL = ['index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 앱 셸(같은 오리진의 정적 파일)만 캐시 우선 적용.
// Apps Script 동기화 요청·CDN 스크립트는 절대 가로채지 않는다 — 항상 최신 데이터를 받아야 하므로.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && SHELL.includes(url.pathname.replace(/^\//, ''))) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
