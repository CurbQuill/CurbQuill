const INVENTORY = {"version":"b305ef49c64fdb2fb566","files":{"app.js":"693d8e28643de5245a45b941e8780aacf2ae344894b6b062de267cfd88d225b0","assets/icon-192.png":"d5148992b015ca6066f71e8c31def6510f264a0924db437dbbd79bd7dfd72883","assets/icon-512.png":"0b677c251ca3dde867736be8101c91b5f09a924e69251daff5fe289af9e4a4ba","csv.js":"6b283a45db9236b22e026e3898e9bb7e6c159c85bf0fe7cea5b3fc7598d965a7","import-ui.js":"ac679c8edb94eae30c402076223f570df5d78413ec276f3b881c3b898e30497b","index.html":"d882c4a3e04ee42ef24afffc7bd3486ea764b4a40990e3d5b8c2d7b146e1cf39","manifest.webmanifest":"7f61173a3d9db4d11cd72f8a872f6d145fb11a02216c9257dc4dd4b5bbf9bace","model.js":"dc5a0e53afe40c4f73dbc806afbe15455b351b7e3db3f9050fb541ff2c4cb206","offline.js":"c760bd83bad181f33e21b222cf9db92967d87cdb3d92fdd0a01f4dcc4ba27061","payout-ui.js":"e5f7dab2ff1bc04a282d8db943feb8dd721fb7563e485d21ab4ec851277d5511","styles.css":"d77204fb4a779aabea612fa046263d6109f92fcb0313210fd8b88680ef81b33f","ui.js":"389475bc53d9e53ae25ee16025e142eec80b2e3ae5bbe4d7921f53a0bb359704","vault.js":"fecf0339a138a8d3925344dca53837bee7ca8090664f19ee8a26d5137caad3b9"}};
const PREFIX = 'curbquill-web-shell:' + self.registration.scope + ':';
const CACHE = PREFIX + INVENTORY?.version;
const urls = new Map(Object.entries(INVENTORY?.files || {}).map(([name, digest]) =>
  [new URL(name, self.registration.scope).href, digest]));
const home = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', event => event.waitUntil(cacheRelease()));

async function cacheRelease(repair = false) {
  if (!INVENTORY) throw new Error('Build the release before installing offline files.');
  const cache = await caches.open(CACHE);
  await Promise.all([...urls].map(async ([url, expected]) => {
    if (repair && await cache.match(url)) return;
    const response = await fetch(url, { cache: 'reload', credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error('Release file unavailable.');
    const hash = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
    const actual = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error('Release file check failed.');
    await cache.put(url, response);
  }));
}

self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener('message', event => {
  if (event.data === 'activate-curbquill-release') event.waitUntil(self.skipWaiting());
  if (event.data === 'check-curbquill-cache' && event.ports[0]) {
    event.waitUntil((async () => {
      try {
        await cacheRelease(true);
        event.ports[0].postMessage({ ready: true, version: INVENTORY.version });
      } catch {
        event.ports[0].postMessage({ ready: false, version: INVENTORY.version });
      }
    })());
  }
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const key = event.request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(home).pathname)
    ? home : url.href;
  if (!urls.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(key)) || fetch(event.request);
  })());
});
