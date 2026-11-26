// Agreement hashes are independent of asset inventories and build versions.
export const normalizedText = text => text.replace(/\r\n?/g, '\n');
export async function agreementHash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedText(text)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
}
// Verified agreement shipped by the previous version-only receipt workflow.
const legacy = {"1.0":"03fac23a8d894543b3dec264b22302957f01cd373a27d258ba705c81a1c7f733"};
export function receiptKey(appId, version, digest) { return appId + ':terms:' + version + ':' + digest; }
export function hasAgreement(storage, appId, version, digest) {
  const key = receiptKey(appId, version, digest);
  try {
    if (storage.getItem(key) === 'agreed') return true;
    if (legacy[version] === digest && storage.getItem(appId + ':terms:' + version) === 'agreed') {
      storage.setItem(key, 'agreed');
      return true;
    }
  } catch {}
  return false;
}
