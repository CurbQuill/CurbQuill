// Asset integrity is separate from the normalized agreement-content hash.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const files=["app.js","assets/icon-192.png","assets/icon-512.png","csv.js","import-ui.js","index.html","manifest.webmanifest","model.js","offline.js","payout-ui.js","styles.css","ui.js","vault.js","terms.mjs","terms-ui.mjs","terms-entry.mjs","terms.css","terms.json","privacy.html","privacy.css","consent.mjs","LICENSE","THIRD-PARTY-NOTICES.md"];
const digest=b=>createHash('sha256').update(b).digest('hex');
const hashes=Object.fromEntries(files.map(file=>{let bytes=fs.readFileSync(path.join(root,file));return [file,digest(bytes)];}));
const version=digest(JSON.stringify(hashes)).slice(0,20);
const sw=path.join(root,'sw.js');let text=fs.readFileSync(sw,'utf8');
text=text.replace(/const INVENTORY = .*;/,'const INVENTORY = '+JSON.stringify({version,files:hashes})+';');
if(process.argv.includes('--check')){if(text!==fs.readFileSync(sw,'utf8'))throw Error('Service-worker inventory is stale');}else fs.writeFileSync(sw,text);
console.log('CurbQuill asset inventory '+version);
