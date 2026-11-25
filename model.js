export const categories = {
  income: ['Delivery pay', 'Tips', 'Other', 'Unsorted'],
  expense: ['Fuel', 'Vehicle upkeep', 'Parking and tolls', 'Supplies', 'Platform fee', 'Other', 'Unsorted'],
  payout: ['Payout']
};
export const kinds = { income: 'Income', expense: 'Expense', payout: 'Payout' };
export const LIMIT = 10000;
export const MAPPING_FIELDS = ['date', 'kind', 'platform', 'account', 'category', 'amount', 'reference', 'notes'];
const MAX_CENTS = 999999999;
const fail = message => { throw new Error(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const scope = value => value.toLowerCase();
const amountFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = cents => amountFormat.format(cents / 100);
export const decimal = cents => (cents / 100).toFixed(2);
export const newId = () => crypto.randomUUID();

export function blankBook() {
  return { schema: 1, id: newId(), rows: [], reviews: [], history: [], batches: [], settings: { lockMinutes: 5, mappings: [] } };
}

function field(value, max, label, required = true, multiline = false) {
  const controls = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u : /[\u0000-\u001F\u007F]/u;
  if (typeof value !== 'string' || value.length > max || controls.test(value) || (required && !value.trim())) {
    fail(label + ' must be valid text up to ' + max + ' characters.');
  }
  return value;
}

export function parseAmount(value) {
  const parts = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!parts) fail('Enter a positive USD amount with up to two decimal places.');
  return checkedAmount(Number(parts[1]) * 100 + Number((parts[2] || '').padEnd(2, '0')));
}

function checkedAmount(cents) {
  if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_CENTS) fail('Amount must be $0.01 to $9,999,999.99.');
  return cents;
}

export function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    date >= '2000-01-01' && date <= '2099-12-31' &&
    !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

export function facts(raw) {
  const { kind, date, category } = raw;
  if (!Object.hasOwn(categories, kind)) fail('Choose income, expense, or payout.');
  if (!validDate(date)) fail('Choose a real date from 2000 to 2099 in YYYY-MM-DD format.');
  if (!categories[kind].includes(category)) fail('Choose a category for this record type.');
  return {
    kind, date, platform: field(raw.platform, 70, 'Platform').trim(),
    account: field(raw.account, 70, 'Source account', false).trim(),
    category, cents: checkedAmount(raw.cents),
    reference: field(raw.reference, 160, 'Reference'),
    notes: field(raw.notes, 800, 'Notes', false, true).replace(/\r\n?/g, '\n')
  };
}

export function evidenceKey(row) {
  if (row.reference.startsWith('@csv:')) return JSON.stringify(['batch row', row.reference]);
  return JSON.stringify([scope(row.platform), scope(row.account), row.kind, row.reference]);
}

export function indexEvidence(book) {
  const index = new Map();
  for (const row of book.rows) {
    for (const version of row.versions) {
      const key = evidenceKey(version);
      if (index.has(key) && index.get(key).id !== row.id) fail('Two records share the same evidence reference.');
      index.set(key, row);
    }
  }
  return index;
}

function sameEvidence(left, right) {
  return same({ ...left, platform: scope(left.platform), account: scope(left.account) },
    { ...right, platform: scope(right.platform), account: scope(right.account) });
}

export function lookalikeKey(row) {
  return JSON.stringify([row.kind, row.date, row.cents, scope(row.platform), scope(row.account)]);
}

export function classify(book, values, index = indexEvidence(book), lookalikes = book.rows) {
  const row = index.get(evidenceKey(values));
  if (row) {
    const alreadySaved = row.versions.some(version => sameEvidence(version, values));
    return { status: alreadySaved ? 'duplicate' : 'conflict', row };
  }
  const key = lookalikeKey(values);
  const similar = lookalikes.find(candidate => lookalikeKey(candidate) === key);
  return similar ? { status: 'review', row: similar } : { status: 'new' };
}

function log(book, kind, id, reason, before, after) {
  book.history.push({ kind, id, reason, before, after, at: new Date().toISOString() });
}

export function addRecord(book, raw, distinct = false, index) {
  const values = facts(raw);
  const check = classify(book, values, index, distinct ? [] : book.rows);
  if (check.status === 'duplicate') return { changed: false, message: 'This record was already saved.' };
  if (check.status === 'conflict') fail('This reference already has different details. Open the saved record to correct it.');
  if (check.status === 'review' && !distinct) fail('A record has the same date, platform, and amount. Confirm this is a separate record.');
  if (book.rows.length >= LIMIT) fail('This book holds up to 10,000 records.');
  const row = { id: newId(), ...values, versions: [values] };
  book.rows.push(row);
  index?.set(evidenceKey(row), row);
  return { changed: true, message: 'Record saved.' };
}

export function editRecord(book, id, expected, raw, reason) {
  const index = book.rows.findIndex(row => row.id === id);
  const previous = book.rows[index];
  if (!previous) fail('The record is unavailable.');
  const current = facts(previous);
  const values = facts({ ...raw, reference: previous.reference });
  if (same(values, current)) return { changed: false, message: 'No record changes.' };
  if (!same(current, expected)) fail('This record changed. Reopen the current record before editing.');
  reason = field(reason, 240, 'Correction reason').trim();
  const collision = indexEvidence(book).get(evidenceKey(values));
  if (collision && collision.id !== id) fail('This correction would reuse another record’s evidence reference.');
  if (current.kind === 'payout' && values.kind !== 'payout' && book.reviews.some(review => review.payoutId === id)) {
    fail('A payout with review history must remain a payout.');
  }
  const linked = book.reviews.some(review => review.state !== 'open' &&
    (review.payoutId === id || review.feeId === id || review.allocations.some(link => link.earningId === id)));
  if (linked && ['kind', 'cents', 'platform', 'account'].some(key => current[key] !== values[key])) {
    fail('Reopen each affected payout review before changing type, amount, platform, or account.');
  }
  if (linked && current.category === 'Platform fee' && values.category !== 'Platform fee') {
    fail('Reopen the payout review before changing the linked fee category.');
  }
  book.rows[index] = { id, ...values, versions: [...previous.versions, values] };
  log(book, 'Record corrected', id, reason, current, values);
  return { changed: true, message: 'Correction saved.' };
}

export function summarize(rows) {
  let income = 0;
  let spending = 0;
  let payouts = 0;
  for (const { kind, cents } of rows) {
    if (kind === 'income') income += cents;
    if (kind === 'expense') spending += cents;
    if (kind === 'payout') payouts += cents;
  }
  return { income, spending, difference: income - spending, payouts };
}

export function sameAccount(left, right) {
  return scope(left.platform) === scope(right.platform) && scope(left.account) === scope(right.account);
}

export function reviewFacts(book, payoutId, raw, rows = new Map(book.rows.map(row => [row.id, row]))) {
  const payout = rows.get(payoutId);
  if (!payout || payout.kind !== 'payout') fail('Choose a saved payout.');
  if (!['pending', 'confirmed', 'open'].includes(raw.state) || !Array.isArray(raw.allocations)) fail('Invalid review.');
  if (raw.state === 'open' && (raw.allocations.length || raw.feeId)) fail('An open review cannot have links.');
  const used = new Map();
  const otherFees = new Set();
  for (const review of book.reviews) {
    if (review.payoutId === payoutId || review.state !== 'confirmed') continue;
    for (const allocation of review.allocations) {
      used.set(allocation.earningId, (used.get(allocation.earningId) || 0) + allocation.cents);
    }
    if (review.feeId) otherFees.add(review.feeId);
  }
  const seen = new Set();
  const allocations = raw.allocations.map(({ earningId, cents }) => {
    const earning = rows.get(earningId);
    if (!earning || earning.kind !== 'income' || !sameAccount(payout, earning)) fail('Choose earnings from the payout’s source account.');
    if (seen.has(earningId)) fail('Combine allocations to the same earning into a single amount.');
    seen.add(earningId);
    checkedAmount(cents);
    if (cents + (used.get(earningId) || 0) > earning.cents) fail('An allocation exceeds the earning’s available balance.');
    return { earningId, cents };
  }).sort((left, right) => left.earningId.localeCompare(right.earningId));
  const feeId = raw.feeId;
  const fee = rows.get(feeId);
  if (feeId !== null && (!fee || fee.kind !== 'expense' || fee.category !== 'Platform fee' ||
    !sameAccount(fee, payout) || otherFees.has(feeId))) {
    fail('Choose an existing Platform fee expense from this account that is available for this payout.');
  }
  const gross = allocations.reduce((total, link) => total + link.cents, 0);
  const net = gross - (fee?.cents || 0);
  const difference = payout.cents - net;
  if (raw.state === 'confirmed' && difference !== 0) fail('The cash received must equal gross allocations minus the recorded fee to confirm.');
  if (raw.state === 'pending' && !allocations.length && !fee) fail('Add an allocation or a recorded fee before saving a pending review.');
  return { review: { payoutId, state: raw.state, allocations, feeId }, gross, net, difference };
}

export function saveReview(book, payoutId, expectedRevision, raw, reason = '') {
  const original = book.reviews.find(review => review.payoutId === payoutId);
  const comparable = {
    payoutId, state: raw.state,
    allocations: [...raw.allocations].sort((left, right) => left.earningId.localeCompare(right.earningId)),
    feeId: raw.feeId
  };
  const prior = book.history.some(event => event.kind === 'Payout review' && event.id === payoutId &&
    (event.before?.revision || 0) === expectedRevision && same(event.after, { ...comparable, revision: expectedRevision + 1 }));
  if (prior || (original && same(original, { ...comparable, revision: original.revision }))) {
    return { changed: false, message: 'This payout review was already saved.' };
  }
  if ((original?.revision || 0) !== expectedRevision) fail('A different review was already saved. Reload the payout and start a revision to change it.');
  if (original && original.state !== 'open') reason = field(reason, 240, 'Revision reason').trim();
  const { review } = reviewFacts(book, payoutId, raw);
  const revised = { ...review, revision: expectedRevision + 1 };
  book.reviews = [...book.reviews.filter(item => item.payoutId !== payoutId), revised];
  log(book, 'Payout review', payoutId, reason, original || null, revised);
  return { changed: true, message: review.state === 'confirmed' ? 'Payout matched.' :
    review.state === 'pending' ? 'Pending review saved.' : 'Payout reopened.' };
}

export function confirmedBalances(book) {
  const balances = new Map(book.rows.filter(row => row.kind === 'income').map(row => [row.id, row.cents]));
  for (const review of book.reviews) {
    if (review.state !== 'confirmed') continue;
    for (const link of review.allocations) balances.set(link.earningId, balances.get(link.earningId) - link.cents);
  }
  return balances;
}

export function validateBook(book) {
  if (!book || book.schema !== 1 || typeof book.id !== 'string' || !book.id ||
    !Array.isArray(book.rows) || book.rows.length > LIMIT || !Array.isArray(book.reviews) ||
    !Array.isArray(book.history) || !Array.isArray(book.batches) || !book.settings ||
    ![1, 5, 15, 30].includes(book.settings.lockMinutes) || !Array.isArray(book.settings.mappings)) fail('Unsupported or damaged record book.');
  const rowIds = new Set();
  for (const row of book.rows) {
    if (typeof row.id !== 'string' || !row.id || rowIds.has(row.id) ||
      !Array.isArray(row.versions) || !row.versions.length) fail('Invalid or repeated record ID.');
    rowIds.add(row.id);
    for (const version of row.versions) {
      if (!same(facts(version), version)) fail('Invalid record history.');
    }
    if (!same(facts(row), row.versions.at(-1))) fail('Invalid current record version.');
  }
  indexEvidence(book);
  const payoutIds = new Set();
  const usedFees = new Set();
  const recordIndex = new Map(book.rows.map(row => [row.id, row]));
  const singleReview = { reviews: [] };
  for (const review of book.reviews) {
    if (payoutIds.has(review.payoutId) || !Number.isSafeInteger(review.revision) || review.revision < 1) fail('Invalid or repeated payout review.');
    payoutIds.add(review.payoutId);
    const { review: canonical } = reviewFacts(singleReview, review.payoutId, review, recordIndex);
    if (!same({ ...canonical, revision: review.revision }, review)) fail('Invalid payout review.');
    if (review.state === 'confirmed' && review.feeId) {
      if (usedFees.has(review.feeId)) fail('A fee expense explains more than one payout.');
      usedFees.add(review.feeId);
    }
  }
  // Pending proposals may become stale when another payout uses the same balance.
  if ([...confirmedBalances(book).values()].some(amount => amount < 0)) fail('Confirmed allocations exceed an earning’s available balance.');
  const historyHeads = new Map();
  for (const event of book.history) {
    if (!event || !rowIds.has(event.id) || typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at)) ||
      typeof event.reason !== 'string' || event.reason.length > 240) fail('Invalid decision history.');
    if (event.kind === 'Record corrected') {
      if (!same(facts(event.before), event.before) || !same(facts(event.after), event.after)) fail('Invalid correction history.');
    } else if (event.kind === 'Payout review') {
      if (!same(historyHeads.get(event.id) || null, event.before) || event.after?.payoutId !== event.id ||
        event.after.revision !== (event.before?.revision || 0) + 1 || !Array.isArray(event.after.allocations) ||
        !['open', 'pending', 'confirmed'].includes(event.after.state) ||
        event.after.allocations.some(link => !rowIds.has(link.earningId) || !checkedAmount(link.cents)) ||
        (event.after.feeId !== null && !rowIds.has(event.after.feeId))) fail('Invalid payout decision history.');
      historyHeads.set(event.id, event.after);
    } else fail('Unknown decision history.');
  }
  if (historyHeads.size !== book.reviews.length || book.reviews.some(review => !same(historyHeads.get(review.payoutId), review))) {
    fail('Current payout reviews do not match their decision history.');
  }
  const batchKeys = new Set();
  for (const batch of book.batches) {
    field(batch.key, 50, 'Batch reference');
    if (batchKeys.has(batch.key) || !/^[a-f0-9]{64}$/.test(batch.signature)) fail('Invalid import receipt.');
    batchKeys.add(batch.key);
  }
  const names = new Set();
  for (const preset of book.settings.mappings) {
    field(preset.name, 60, 'Mapping name');
    if (names.has(preset.name)) fail('Repeated import setting name.');
    names.add(preset.name);
    field(preset.platform, 70, 'Default platform', false);
    field(preset.account, 70, 'Default source account', false);
    if (!['', ...Object.keys(kinds)].includes(preset.kind) || !preset.columns ||
      MAPPING_FIELDS.some(key => typeof preset.columns[key] !== 'string' || preset.columns[key].length > 160)) fail('Invalid import settings.');
  }
  return book;
}
