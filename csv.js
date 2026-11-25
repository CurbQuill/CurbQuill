import { addRecord, categories, classify, decimal, evidenceKey, facts, indexEvidence, LIMIT, lookalikeKey, MAPPING_FIELDS, parseAmount } from './model.js';

export const CSV_BYTES = 48_000_000;
const headers = ['curbquill_version', 'reference', 'date', 'type', 'description', 'category', 'amount_usd', 'platform', 'source_account'];
const protect = /^[\s]*[=+@\-＝＋＠－]|^[\t\r\n]|^'/u;
const unprotect = value => value.startsWith("'") && protect.test(value.slice(1)) ? value.slice(1) : value;
const aliases = {
  reference: ['reference', 'transaction_id', 'payout_id', 'id'],
  date: ['date', 'transaction_date', 'payout_date'],
  kind: ['type', 'kind', 'transaction_type'],
  notes: ['description', 'notes', 'memo'],
  category: ['category'],
  amount: ['amount_usd', 'amount'],
  platform: ['platform', 'provider'],
  account: ['source_account', 'account']
};

export function readCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  function pushCell() {
    row.push(cell);
    if (row.length > 120) throw new Error('CSV supports up to 120 columns.');
    cell = '';
    closed = false;
  }
  function pushRow() {
    pushCell();
    if (row.some(value => value !== '')) rows.push(row);
    if (rows.length > LIMIT + 1) throw new Error('CSV supports up to 10,000 data rows.');
    row = [];
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else cell += ch;
    } else if (ch === ',') pushCell();
    else if (ch === '\r' || ch === '\n') {
      pushRow();
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else if (closed) throw new Error('Unexpected text after a quoted CSV field.');
    else if (ch === '"') {
      if (cell) throw new Error('Unexpected quote in a CSV field.');
      quoted = true;
    } else cell += ch;
  }
  if (quoted) throw new Error('A quoted CSV field was not closed.');
  if (cell || row.length || closed) pushRow();
  const header = rows.shift()?.map(value => value.trim());
  if (!header || header.some(value => !value || value.length > 160) || new Set(header).size !== header.length) {
    throw new Error('Use a CSV with distinct, nonempty column headings.');
  }
  if (!rows.length) throw new Error('This CSV has a header but no records.');
  return { header, rows };
}

export function suggestMapping(header) {
  return Object.fromEntries(MAPPING_FIELDS.map(field => [field, aliases[field].map(alias =>
    header.find(name => name.toLowerCase() === alias)).find(Boolean) || '']));
}

async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function makePreview(book, file, settings) {
  const indices = Object.fromEntries(MAPPING_FIELDS.map(field => [field, file.header.indexOf(settings.columns[field])]));
  if (indices.date < 0 || indices.amount < 0 || (indices.kind < 0 && !settings.kind) ||
    (indices.platform < 0 && !settings.platform.trim())) {
    throw new Error('Map date and amount, and map or supply a default for type and platform.');
  }
  const batchKey = settings.batch.trim();
  if (batchKey && !/^[a-zA-Z0-9_-]{1,50}$/.test(batchKey)) {
    throw new Error('Use up to 50 letters, numbers, dashes, or underscores for the batch reference.');
  }
  const versionIndex = file.header.indexOf('curbquill_version');
  const evidence = indexEvidence(book);
  const lookalikes = new Map(book.rows.map(row => [lookalikeKey(row), [row]]));
  const rows = file.rows.map((cells, index) => {
    try {
      if (cells.length !== file.header.length) throw new Error('The number of fields does not match the header.');
      const own = versionIndex >= 0 && cells[versionIndex] === 'CurbQuill Web 1';
      const value = field => {
        const cell = cells[indices[field]] ?? '';
        return own ? unprotect(cell) : cell;
      };
      let reference = value('reference');
      if (!reference) {
        if (!batchKey) throw new Error('Give this file a stable batch reference or map a reference column for every row.');
        reference = '@csv:' + batchKey + ':' + (index + 1);
      } else if (!own && reference.startsWith('@csv:')) {
        throw new Error('This reference starts with the reserved text @csv:.');
      }
      const kind = (value('kind').trim() || settings.kind).toLowerCase();
      const label = value('category').trim();
      const category = categories[kind]?.find(item => item.toLowerCase() === label.toLowerCase()) ||
        (label || (kind === 'payout' ? 'Payout' : 'Unsorted'));
      const data = facts({ kind, category, reference, date: value('date').trim(),
        platform: value('platform').trim() || settings.platform,
        account: value('account').trim() || settings.account,
        cents: parseAmount(value('amount')), notes: value('notes') });
      const lookalike = lookalikeKey(data);
      const result = classify(book, data, evidence, lookalikes.get(lookalike) || []);
      if (result.status === 'new' || result.status === 'review') {
        evidence.set(evidenceKey(data), { ...data, versions: [data] });
        if (!lookalikes.has(lookalike)) lookalikes.set(lookalike, [data]);
      }
      return { line: index + 1, data, status: result.status, comparison: result.row };
    } catch (error) {
      return { line: index + 1, status: 'invalid', issue: error.message };
    }
  });
  // An explicit batch reference also identifies structural changes, even if a revised file now has IDs.
  const batch = batchKey ? { key: batchKey, signature: await fingerprint(
    rows.map((row, index) => row.data || file.rows[index])) } : null;
  const previous = batch && book.batches.find(receipt => receipt.key === batch.key);
  const batchConflict = Boolean(previous && previous.signature !== batch.signature);
  return { rows, batch, batchConflict, blocked: batchConflict || rows.some(row => ['invalid', 'conflict'].includes(row.status)) };
}

export function saveMapping(book, name, raw) {
  name = name.trim();
  if (!name || name.length > 60) throw new Error('Enter a mapping name of 1–60 characters.');
  const mapping = { name, columns: raw.columns, platform: raw.platform.trim(), account: raw.account.trim(), kind: raw.kind };
  const prior = book.settings.mappings.find(item => item.name === name);
  if (JSON.stringify(prior) === JSON.stringify(mapping)) return false;
  if (!prior && book.settings.mappings.length >= 30) throw new Error('Save up to 30 mappings.');
  book.settings.mappings = [...book.settings.mappings.filter(item => item.name !== name), mapping].sort((a, b) => a.name.localeCompare(b.name));
  return true;
}

export async function commitImport(book, file, settings, selected, name) {
  const preview = await makePreview(book, file, settings);
  if (preview.blocked) throw new Error('This import has conflicts or invalid rows. No records were saved.');
  const evidence = indexEvidence(book);
  let added = 0;
  for (const row of preview.rows) {
    if (!selected.has(row.line) || !['new', 'review'].includes(row.status)) continue;
    const result = addRecord(book, row.data, true, evidence);
    if (result.changed) added += 1;
  }
  const savedMapping = name.trim() ? saveMapping(book, name, settings) : false;
  if (added && preview.batch && !book.batches.some(batch => batch.key === preview.batch.key)) book.batches.push(preview.batch);
  return { changed: added > 0 || savedMapping, message: added + ' records imported.' +
    (savedMapping ? ' Mapping saved.' : '') + (added ? '' : ' Existing records were preserved.') };
}

export function writeCsv(rows) {
  function quote(value) {
    return '"' + (protect.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
  }
  return [headers.join(','), ...rows.map(row => [
    'CurbQuill Web 1', row.reference, row.date, row.kind, row.notes, row.category,
    decimal(row.cents), row.platform, row.account
  ].map(quote).join(','))].join('\r\n') + '\r\n';
}
