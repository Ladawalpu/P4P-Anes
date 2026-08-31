const CACHE = 'p4p-anes-v2';
const ASSETS = ['./index.html', './manifest.json'];
// ไฟล์ที่ต้องอัปเดตได้ทันทีเสมอ (โหลดจากอินเทอร์เน็ตสดก่อน ใช้แคชเป็นตัวสำรองตอนออฟไลน์เท่านั้น)
const NETWORK_FIRST = ['index.html', 'manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return; // let POST sync calls go straight to network

  const isNetworkFirst = NETWORK_FIRST.some(name => e.request.url.indexOf(name) !== -1);

  if (isNetworkFirst) {
    // โหลดสดจากอินเทอร์เน็ตก่อนเสมอ เพื่อให้เห็นการแก้ไขล่าสุดทันที ไม่ต้องรอเคลียร์แคชเอง
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request)) // ออฟไลน์ค่อยใช้แคชสำรอง
    );
    return;
  }

  // ไฟล์อื่น (เช่นไอคอน) ยังใช้แคชก่อนตามเดิม เพื่อความเร็วและใช้งานออฟไลน์ได้
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => cached))
  );
});
