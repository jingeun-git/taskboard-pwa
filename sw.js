/*
 * sw.js — taskboard 서비스워커 (SYS-217, 2026-08-26 재작성)
 *
 * 목적은 「오프라인에서 쓰기」가 아니라 「오프라인에서 정직하게 실패하기」다.
 * 앱 껍데기를 캐시해 두면 연결이 없을 때도 화면이 떠서 "연결 없음"을 말할 수 있다.
 * 캐시가 없으면 브라우저 기본 오류 화면이 뜨고, 사용자는 앱이 죽었는지 인터넷이
 * 끊겼는지 구별할 수 없다.
 *
 * 종전 결함(SYS-217 D5): fetch 핸들러가
 *     SHELL.includes(url.pathname.replace(/^\//,''))
 * 로 판정했는데, 실제 배포 경로가 /taskboard-pwa/index.html이라 앞의 폴더명이 남아
 * 목록과 영원히 어긋났다. 그래서 이 워커는 아무것도 가로채지 못했고, 오프라인에서
 * 앱이 떴던 것은 서비스워커가 아니라 브라우저 디스크 캐시 덕이었다(= 뜰 때도 있고
 * 안 뜰 때도 있었다). 이제 registration.scope로 판정해 배포 위치와 무관하게 맞는다.
 *
 * 전략은 네트워크 우선이다. 온라인이면 언제나 최신 파일을 받으므로 이 파일의
 * CACHE 값을 안 올려서 예전 화면이 계속 뜨는 사고(2026-07 v3-6)가 재발하지 않는다.
 */

var CACHE = 'taskboard-shell-v7';
var SHELL = ['./', './index.html', './manifest.json', './vendor-preact.js', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // 같은 폴더(=배포 범위) 안의 우리 파일만 다룬다.
  // 구글 로그인(accounts.google.com)과 백엔드(script.google.com)는 다른 오리진이라
  // 여기서 걸러진다 — 저 둘은 절대 캐시하지 않는다.
  if (req.url.indexOf(self.registration.scope) !== 0) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        // 페이지 이동 요청이면 앱 껍데기라도 돌려준다 — 앱이 스스로 "연결 없음"을 띄운다
        if (req.mode === 'navigate') return caches.match(self.registration.scope + 'index.html');
        return Response.error();
      });
    })
  );
});
