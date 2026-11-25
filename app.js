import { addRecord, categories, classify, decimal, editRecord, facts, kinds, money, newId, parseAmount, summarize, validDate } from './model.js';
import { BACKUP_BYTES, createVault, openDatabase, openEnvelope, readLocalFile, readVault, writeVault, seal } from './vault.js';
import { writeCsv } from './csv.js';
import { makeImportUI } from './import-ui.js';
import { makePayoutUI } from './payout-ui.js';
import { wireOffline } from './offline.js';
import { $, $$, button, dateLabel, during, el, empty, metricNodes, options, report } from './ui.js';

const gate = $('#gate');
const gateForm = $('#gate-form');
const app = $('#app');
const feedback = $('#feedback');
const filters = $('#filters');
const entryDialog = $('#entry-dialog');
const entryForm = $('#entry-form');
const restoreDialog = $('#restore-dialog');
const restoreForm = $('#restore-form');
const restoreInputs = $('#restore-inputs');
const exportDialog = $('#export-dialog');
const lockSettings = $('#lock-settings');
const bookPageSize = 40;
const kindOptions = Object.entries(kinds);
let db;
let session = null;
let lockTimer;
let lastActive = 0;
let selectedPage = 'book';
let gateEpoch = 0;
let working = false;
let edited = null;
let ledgerPage = 0;
let restoring = null;
const downloadUrls = new Set();

const currentBook = () => session?.book;
const notify = (message, error = false) => report(feedback, message, error);
const dialogError = (dialog, error) => {
  if (dialog.open) report(dialog.querySelector('[data-error]'), error?.message, Boolean(error));
};

async function mutate(operation) {
  const active = session;
  if (!active) throw new Error('Unlock the vault first.');
  if (working) throw new Error('Another change is being saved. Try again in a moment.');
  working = true;
  try {
    const book = structuredClone(active.book);
    const outcome = await operation(book);
    if (session !== active) throw new Error('The vault locked before the change was saved.');
    if (!outcome.changed) return outcome;
    const nextBook = outcome.book || book;
    const envelope = await seal(nextBook, active.key, active.salt);
    if (session !== active) throw new Error('The vault locked before the change was saved.');
    const revision = await writeVault(db, active.revision, envelope);
    if (session === active) {
      active.book = nextBook;
      active.revision = revision;
      touch();
    }
    return outcome;
  } finally {
    working = false;
  }
}

const payoutUI = makePayoutUI({ currentBook, mutate, notify, dialogError, showEntry });
const importUI = makeImportUI({ currentBook, mutate, notify, dialogError, onSaved: render });

function showPage(page, moveFocus = true) {
  selectedPage = page;
  for (const item of $$('.sidebar [data-page]')) {
    if (item.dataset.page === page) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  for (const section of $$('.page')) section.hidden = section.id !== page;
  if (moveFocus) {
    notify('');
    $('#' + page + '-title').focus();
  }
}

function sorted(rows) {
  return [...rows].sort((a, b) => b.date.localeCompare(a.date) || a.reference.localeCompare(b.reference));
}

function uniquePlatforms(rows) {
  const labels = new Map();
  for (const { platform } of rows) if (!labels.has(platform.toLowerCase())) labels.set(platform.toLowerCase(), platform);
  return [...labels].sort((a, b) => a[1].localeCompare(b[1]));
}

function ledgerScope(book) {
  const { query, from, through, category, platform } = filters.elements;
  const term = query.value.trim().toLowerCase();
  const invalid = !from.validity.valid || !through.validity.valid ||
    (from.value && !validDate(from.value)) || (through.value && !validDate(through.value)) ||
    (from.value && through.value && from.value > through.value);
  const rows = invalid ? [] : sorted(book.rows.filter(row => row.kind !== 'payout' &&
    (!from.value || row.date >= from.value) && (!through.value || row.date <= through.value) &&
    (!category.value || row.category === category.value) && (!platform.value || row.platform.toLowerCase() === platform.value) &&
    (!term || [row.reference, row.notes, row.platform, row.category, row.account, row.kind].some(value => value.toLowerCase().includes(term)))));
  return { invalid, rows };
}

function renderLedger() {
  const book = currentBook();
  if (!book) return;
  const all = summarize(book.rows);
  const count = book.rows.filter(row => row.kind !== 'payout').length;
  $('#whole-count').textContent = count + (count === 1 ? ' transaction' : ' transactions') + ' · USD';
  $('#whole-metrics').replaceChildren(...metricNodes([
    ['Recorded income', all.income, 'Earnings entered'],
    ['Recorded spending', all.spending, 'Business expenses'],
    ['Difference', all.difference, 'Income less spending', 'accent'],
    ['Payouts received', all.payouts, 'Cash received separately', 'cash']
  ]));
  const { rows, invalid } = ledgerScope(book);
  const totals = summarize(rows);
  const heading = el('strong', 'Filtered totals · ' + rows.length + (rows.length === 1 ? ' transaction' : ' transactions'));
  $('#filtered-summary').replaceChildren(heading,
    el('span', 'Income ' + money(totals.income)), el('span', 'Spending ' + money(totals.spending)),
    el('span', 'Difference ' + money(totals.difference)));
  const pages = Math.max(1, Math.ceil(rows.length / bookPageSize));
  ledgerPage = Math.min(ledgerPage, pages - 1);
  $('#ledger-body').replaceChildren(...rows.slice(ledgerPage * bookPageSize, (ledgerPage + 1) * bookPageSize).map(row => {
    const tr = el('tr');
    const desc = el('td');
    desc.append(el('strong', kinds[row.kind]), el('small', row.notes || row.reference, 'description'));
    const platform = el('td', row.platform);
    if (row.account) platform.append(el('small', row.account));
    const action = el('td');
    const edit = button('Edit', 'text', () => showEntry(row.kind, row));
    edit.setAttribute('aria-label', 'Edit record ' + row.reference);
    action.append(edit);
    tr.append(el('td', dateLabel(row.date)), desc, platform, el('td', row.category), el('td', money(row.cents), 'number'), action);
    return tr;
  }));
  $('#ledger-table-wrap').hidden = !rows.length;
  const noRecords = $('#ledger-empty');
  noRecords.hidden = Boolean(rows.length);
  if (invalid) empty(noRecords, 'Check the date range', 'Enter valid dates with the earlier date first.');
  else if (!rows.length && count) empty(noRecords, 'No transactions match', 'Clear the filters or try a different search.');
  else if (!rows.length) {
    empty(noRecords, 'Your record book is empty', 'Add an earning or expense, or import a CSV to get started.');
    noRecords.append(button('Import a CSV', 'secondary', () => { showPage('transfer'); importUI.open(); }));
  }
  $('#ledger-pagination').hidden = pages <= 1;
  $('#ledger-page').textContent = 'Page ' + (ledgerPage + 1) + ' of ' + pages;
  $('#ledger-prev').disabled = ledgerPage === 0;
  $('#ledger-next').disabled = ledgerPage >= pages - 1;
}

function render() {
  const book = currentBook();
  if (!book) return;
  const seen = uniquePlatforms(book.rows);
  const { category, platform } = filters.elements;
  const categoryList = [...new Set([...categories.income, ...categories.expense])].sort();
  options(category, [['', 'All categories'], ...categoryList.map(value => [value, value])], category.value);
  options(platform, [['', 'All platforms'], ...seen], platform.value);
  $('#platforms').replaceChildren(...seen.map(([, label]) => new Option(label, label)));
  const presetCount = book.settings.mappings.length;
  $('#mapping-count').textContent = presetCount ? presetCount + (presetCount === 1 ? ' saved mapping' : ' saved mappings') : '';
  lockSettings.elements.minutes.value = book.settings.lockMinutes;
  renderLedger();
  payoutUI.render();
}

function localToday() {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
}

function updateEntryCategory(value = '') {
  const kind = entryForm.elements.kind.value;
  options(entryForm.elements.category, categories[kind].map(item => [item, item]), value || (kind === 'payout' ? 'Payout' : 'Unsorted'));
}

function showEntry(kind, row = null) {
  edited = row;
  entryForm.reset();
  report(entryDialog.querySelector('[data-error]'));
  const fields = entryForm.elements;
  const allowed = row?.kind === 'payout' || (!row && kind === 'payout') ? [['payout', 'Payout']] : kindOptions.filter(([value]) => value !== 'payout');
  options(fields.kind, allowed, row?.kind || kind);
  fields.date.value = row?.date || localToday();
  fields.reference.value = row?.reference || 'CQ-' + newId().slice(0, 12);
  fields.reference.readOnly = Boolean(row);
  fields.platform.value = row?.platform || '';
  fields.account.value = row?.account || '';
  fields.amount.value = row ? decimal(row.cents) : '';
  fields.notes.value = row?.notes || '';
  fields.reason.required = Boolean(row);
  $('#correction-label').hidden = !row;
  $('#distinct-label').hidden = true;
  $('#entry-title').textContent = row ? 'Edit ' + (kind === 'payout' ? 'payout' : 'record') : kind === 'payout' ? 'Record payout' : 'New record';
  $('#save-entry').textContent = row ? 'Save correction' : 'Save record';
  updateEntryCategory(row?.category);
  entryDialog.showModal();
  (row ? fields.date : kind === 'payout' ? fields.platform : fields.kind).focus();
}

entryForm.elements.kind.addEventListener('change', () => updateEntryCategory());
entryForm.addEventListener('submit', event => {
  event.preventDefault();
  during(entryForm, async () => {
    const fields = entryForm.elements;
    const previous = edited;
    const data = facts({
      date: fields.date.value, kind: fields.kind.value, category: fields.category.value,
      platform: fields.platform.value, account: fields.account.value, cents: parseAmount(fields.amount.value),
      reference: fields.reference.value, notes: fields.notes.value
    });
    if (!previous && data.reference.startsWith('@csv:')) throw new Error('References starting with @csv: are reserved for imported rows.');
    if (!previous && !fields.distinct.checked) {
      const similar = classify(currentBook(), data);
      if (similar.status === 'review') {
        $('#distinct-label').hidden = false;
        throw new Error('Similar saved record: ' + similar.row.reference + '. Confirm if this is a separate record.');
      }
    }
    const result = await mutate(book => previous ? editRecord(book, previous.id, facts(previous), data, fields.reason.value) :
      addRecord(book, data, fields.distinct.checked));
    if (!entryDialog.open) return;
    entryDialog.close();
    render();
    notify(result.message);
    if (previous && selectedPage === 'book') {
      ($$('#ledger-body button').find(item => item.getAttribute('aria-label') === 'Edit record ' + previous.reference) || $('#add-record')).focus();
    } else if (selectedPage === 'payouts') $('#add-payout').focus();
  }, error => dialogError(entryDialog, error));
});
entryDialog.addEventListener('close', () => { entryForm.reset(); edited = null; });

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  downloadUrls.add(url);
  const link = el('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 2000);
}

$('#start-export').addEventListener('click', () => {
  const book = currentBook();
  const scope = ledgerScope(book);
  const items = [['whole', 'Whole record book (' + book.rows.length + ' rows)']];
  if (!scope.invalid) items.push(['view', 'Filtered transactions (' + scope.rows.length + ' rows)']);
  options($('#export-form').elements.scope, items);
  exportDialog.showModal();
  $('#export-form').elements.scope.focus();
});

$('#export-form').addEventListener('submit', event => {
  event.preventDefault();
  const filtered = event.currentTarget.elements.scope.value === 'view';
  const book = currentBook();
  download('curbquill-' + (filtered ? 'filtered' : 'whole-book') + '-' + localToday() + '.csv',
    writeCsv(filtered ? ledgerScope(book).rows : sorted(book.rows)), 'text/csv;charset=utf-8');
  exportDialog.close();
  notify('CSV download requested.');
});

$('#backup').addEventListener('click', async () => {
  const active = session;
  const control = $('#backup');
  if (!active || control.disabled) return;
  control.disabled = true;
  try {
    const saved = await readVault(db);
    if (active !== session) return;
    if (saved.revision !== active.revision) throw new Error('Another window saved a change. Lock and unlock before making a backup.');
    download('curbquill-' + localToday() + '.cqvault', JSON.stringify(saved.envelope), 'application/json');
    notify('Encrypted backup download requested.');
  } catch (error) {
    if (active === session) notify(error.message, true);
  } finally {
    control.disabled = false;
  }
});

function clearRestore() {
  restoring = null;
  restoreForm.reset();
  restoreInputs.hidden = false;
  restoreForm.elements.file.required = true;
  restoreForm.elements.password.required = true;
  $('#restore-preview').hidden = true;
  $('#restore-preview').replaceChildren();
  $('#restore-submit').textContent = 'Preview backup';
  report(restoreDialog.querySelector('[data-error]'));
}

$('#start-restore').addEventListener('click', () => {
  clearRestore();
  restoreDialog.showModal();
  restoreForm.elements.file.focus();
});
restoreDialog.addEventListener('close', clearRestore);
restoreForm.addEventListener('submit', event => {
  event.preventDefault();
  const active = session;
  during(restoreForm, async () => {
    dialogError(restoreDialog);
    if (restoring) {
      const candidate = restoring;
      const result = await mutate(book => ({
        changed: JSON.stringify(book) !== JSON.stringify(candidate),
        book: candidate, message: 'Backup restored. This vault keeps its current password.'
      }));
      if (!restoreDialog.open) return;
      restoreDialog.close();
      filters.reset();
      render();
      notify(result.message);
      return;
    }
    const password = restoreForm.elements.password.value;
    restoreForm.elements.password.value = '';
    const file = restoreForm.elements.file.files[0];
    const raw = await readLocalFile(file, BACKUP_BYTES);
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw new Error('Choose a valid CurbQuill encrypted backup.'); }
    const { book } = await openEnvelope(envelope, password);
    if (session !== active || !restoreDialog.open) return;
    restoring = book;
    restoreInputs.hidden = true;
    restoreForm.elements.file.required = false;
    restoreForm.elements.password.required = false;
    const target = $('#restore-preview');
    const totals = summarize(book.rows);
    const count = (items, singular, plural = singular + 's') => items.length + ' ' + (items.length === 1 ? singular : plural);
    target.replaceChildren(el('h3', 'Backup preview'), el('p', 'Book ' + book.id),
      el('p', [count(book.rows, 'record'), count(book.reviews, 'payout review'), count(book.settings.mappings, 'saved mapping')].join(' · ')),
      el('p', 'Income ' + money(totals.income) + ' · Spending ' + money(totals.spending) + ' · Payouts ' + money(totals.payouts)),
      el('p', 'Restoring replaces all records and settings currently in this vault. Cancel to keep them or download an encrypted backup first.', 'message warning'));
    target.hidden = false;
    target.tabIndex = -1;
    target.focus();
    $('#restore-submit').textContent = 'Replace local record book';
  }, error => dialogError(restoreDialog, error));
});

function touch() {
  if (!session) return;
  lastActive = Date.now();
  clearTimeout(lockTimer);
  lockTimer = setTimeout(checkIdle, session.book.settings.lockMinutes * 60000);
}

function checkIdle() {
  if (!session) return;
  const remaining = session.book.settings.lockMinutes * 60000 - (Date.now() - lastActive);
  if (remaining <= 0) lock();
  else {
    clearTimeout(lockTimer);
    lockTimer = setTimeout(checkIdle, remaining);
  }
}

function setupGate(hasVault) {
  $('#gate-title').textContent = hasVault ? 'Unlock your vault' : 'Create your vault';
  $('#gate-description').textContent = hasVault ? 'Enter your password to open the record book on this device.' :
    'Choose a password of at least 12 characters. You’ll need it to open this vault and its backups.';
  $('#gate-action').textContent = hasVault ? 'Unlock vault' : 'Create vault';
  $('#password').autocomplete = hasVault ? 'off' : 'new-password';
  $('#confirm-label').hidden = hasVault;
  $('#confirm-password').required = !hasVault;
  gateForm.hidden = false;
}

function lock() {
  if (!session) return;
  gateEpoch += 1;
  session = null;
  clearTimeout(lockTimer);
  app.hidden = true;
  $('#skip-app').hidden = true;
  $$('dialog[open]').forEach(dialog => dialog.close());
  filters.reset();
  options(filters.elements.category, []);
  options(filters.elements.platform, []);
  options($('#export-form').elements.scope, []);
  entryForm.reset();
  entryForm.elements.reference.value = '';
  edited = null;
  clearRestore();
  payoutUI.clear();
  importUI.clear();
  gateForm.reset();
  ledgerPage = 0;
  ['#whole-metrics', '#filtered-summary', '#ledger-body', '#platforms', '#ledger-empty'].forEach(selector => $(selector).replaceChildren());
  $('#whole-count').textContent = '';
  $('#mapping-count').textContent = '';
  notify('');
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls.clear();
  gate.hidden = false;
  setupGate(true);
  report($('#gate-error'));
  $('#password').focus();
}

gateForm.addEventListener('submit', event => {
  event.preventDefault();
  const generation = gateEpoch;
  during(gateForm, async () => {
    const password = $('#password').value;
    const confirmation = $('#confirm-password').value;
    gateForm.reset();
    report($('#gate-error'));
    const saved = await readVault(db);
    if (!saved && password !== confirmation) throw new Error('The passwords do not match.');
    const opened = saved ? { ...await openEnvelope(saved.envelope, password), revision: saved.revision } :
      await createVault(db, password);
    if (generation !== gateEpoch) return;
    session = opened;
    render();
    showPage('book', false);
    gate.hidden = true;
    app.hidden = false;
    $('#skip-app').hidden = false;
    $('#book-title').focus();
    touch();
  }, error => {
    report($('#gate-error'), error.message, true);
    $('#password').focus();
  });
});

lockSettings.addEventListener('submit', event => {
  event.preventDefault();
  during(lockSettings, async () => {
    const lockMinutes = Number(lockSettings.elements.minutes.value);
    const result = await mutate(book => {
      const changed = book.settings.lockMinutes !== lockMinutes;
      book.settings.lockMinutes = lockMinutes;
      return { changed, message: 'Inactivity lock setting saved.' };
    });
    if (session) notify(result.message);
  }, error => { if (session) notify(error.message, true); });
});

for (const selector of ['#desktop-lock', '#mobile-lock', '#settings-lock']) $(selector).addEventListener('click', lock);
$$('.sidebar [data-page]').forEach(item => item.addEventListener('click', () => showPage(item.dataset.page)));
$('#add-record').addEventListener('click', () => showEntry('income'));
$('#add-payout').addEventListener('click', () => showEntry('payout'));
$('#start-import').addEventListener('click', importUI.open);
$('#ledger-prev').addEventListener('click', () => { ledgerPage -= 1; renderLedger(); });
$('#ledger-next').addEventListener('click', () => { ledgerPage += 1; renderLedger(); });
$('#clear-filters').addEventListener('click', () => { filters.reset(); ledgerPage = 0; renderLedger(); });
filters.addEventListener('input', () => { ledgerPage = 0; renderLedger(); });
filters.addEventListener('submit', event => event.preventDefault());
$$('[data-close]').forEach(control => control.addEventListener('click', () => control.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('cancel', event => {
  if (dialog.querySelector('form').dataset.busy) event.preventDefault();
}));
['pointerdown', 'keydown', 'input'].forEach(event => document.addEventListener(event, () => { checkIdle(); touch(); }, { passive: true }));
document.addEventListener('visibilitychange', checkIdle);
window.addEventListener('pagehide', lock);
wireOffline({ lock, isBusy: () => working || Boolean(gateForm.dataset.busy) });

try {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle || !globalThis.indexedDB) {
    throw new Error('Open CurbQuill using the local preview address or its HTTPS site.');
  }
  db = await openDatabase();
  setupGate(Boolean(await readVault(db)));
} catch (error) {
  $('#gate-title').textContent = 'Vault unavailable';
  $('#gate-description').textContent = error.message;
}
