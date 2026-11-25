import { $, $$ } from './ui.js';

export async function wireOffline({ lock, isBusy }) {
  const updateControls = $$('[data-update]');
  const installControl = $('#install');
  let prompt;
  let activating = false;
  let initial = Boolean(navigator.serviceWorker?.controller);
  function show(text, ready = false) {
    $$('[data-offline]').forEach(node => { node.textContent = text; });
    document.body.classList.toggle('offline-ready', ready);
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    installControl.hidden = false;
  });
  installControl.addEventListener('click', async () => {
    if (!prompt) return;
    const request = prompt;
    prompt = null;
    installControl.hidden = true;
    await request.prompt();
  });
  window.addEventListener('appinstalled', () => { installControl.hidden = true; });
  if (!navigator.serviceWorker) {
    show('Offline setup requires localhost or HTTPS.');
    return;
  }

  async function verify() {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return;
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      show('Offline files could not be verified.');
    }, 4500);
    channel.port1.onmessage = event => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data.ready) show('Ready for offline use', true);
      else show('Offline files are incomplete. Reopen online to repair.');
    };
    controller.postMessage('check-curbquill-cache', [channel.port2]);
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    for (const control of updateControls) control.hidden = true;
    if (activating) location.reload();
    else if (initial) show('Update installed. Reopen CurbQuill to use it.');
    else { initial = true; verify(); }
  });
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    function checkWaiting() {
      for (const control of updateControls) control.hidden = !registration.active || !registration.waiting;
    }
    function watch(worker) {
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') checkWaiting();
        if (worker.state === 'redundant' && !navigator.serviceWorker.controller) {
          show('Offline setup failed. Reopen the complete release online.');
        }
      });
    }
    watch(registration.installing);
    registration.addEventListener('updatefound', () => watch(registration.installing));
    for (const control of updateControls) control.addEventListener('click', () => {
      if (!registration.waiting || isBusy()) return;
      activating = true;
      lock();
      registration.waiting.postMessage('activate-curbquill-release');
    });
    checkWaiting();
    await verify();
    registration.update().catch(() => {});
  } catch {
    show('Offline setup is unavailable.');
  }
}
