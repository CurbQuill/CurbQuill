const INVENTORY = {"version":"efe9e80b59b5c98f9875","files":{"app.js":"693d8e28643de5245a45b941e8780aacf2ae344894b6b062de267cfd88d225b0","assets/icon-192.png":"d5148992b015ca6066f71e8c31def6510f264a0924db437dbbd79bd7dfd72883","assets/icon-512.png":"0b677c251ca3dde867736be8101c91b5f09a924e69251daff5fe289af9e4a4ba","csv.js":"6b283a45db9236b22e026e3898e9bb7e6c159c85bf0fe7cea5b3fc7598d965a7","import-ui.js":"ac679c8edb94eae30c402076223f570df5d78413ec276f3b881c3b898e30497b","index.html":"4c344626de790f917b17746a8aef54355ae5c57fa82e2ace95f718333dd3929f","manifest.webmanifest":"7f61173a3d9db4d11cd72f8a872f6d145fb11a02216c9257dc4dd4b5bbf9bace","model.js":"dc5a0e53afe40c4f73dbc806afbe15455b351b7e3db3f9050fb541ff2c4cb206","offline.js":"c760bd83bad181f33e21b222cf9db92967d87cdb3d92fdd0a01f4dcc4ba27061","payout-ui.js":"e5f7dab2ff1bc04a282d8db943feb8dd721fb7563e485d21ab4ec851277d5511","styles.css":"d77204fb4a779aabea612fa046263d6109f92fcb0313210fd8b88680ef81b33f","ui.js":"389475bc53d9e53ae25ee16025e142eec80b2e3ae5bbe4d7921f53a0bb359704","vault.js":"fecf0339a138a8d3925344dca53837bee7ca8090664f19ee8a26d5137caad3b9","terms.mjs":"c7ab776723a92fa6138a165ed0a6cb2897bd71bc4b743f9f7e229601c24b8279","terms-ui.mjs":"e42efb2831ae9f96272d637862ff4356371ba76ac960cbe0c7a5a6176a26ccb9","terms-entry.mjs":"698e2f19c34c0a4804eb92a98041b3a26ad08d3787ccb8f9bae7013eba052ef6","terms.css":"1b9cb574ad5a9db43795c937e19d5dfde0338dc80542fc430c62f3bfbb93a53d","terms.json":"a312fb005c9703950f544a8cb1915b8588c54a15a2568ea6ae9614bedea8f83b","privacy.html":"f1f8cbc4cc9f032bddd0a19b95b36d91947e429a391f95a454f0534a7e5ed184","privacy.css":"92056245293f8fd2f385fdd7cdab7aa3968f956ea4262274a15114ec35922996","consent.mjs":"ee9606d4d7aac793609be0a54c402050cb1d0793d19b0dd44b5715c21eb6b7c3","LICENSE":"6506caba3da1d291603cd3e089aa7e48601ffa8d274c262bc25fd383da054c3a","THIRD-PARTY-NOTICES.md":"8a1dfd862dc9d4e1f38a9668f9349eaad47383c703aa82e022b10883ed5c0cff"}};
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
  // Check the published agreement even while an older app shell controls this tab.
  if (event.request.url === new URL('terms.json?current', self.registration.scope).href) return;

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
