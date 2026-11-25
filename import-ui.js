import { commitImport, CSV_BYTES, makePreview, readCsv, suggestMapping } from './csv.js';
import { kinds, MAPPING_FIELDS, money } from './model.js';
import { readLocalFile } from './vault.js';
import { $, button, el, options, during, report } from './ui.js';

const labels = { date: 'Date', kind: 'Record type', platform: 'Platform', account: 'Source account',
  category: 'Category', amount: 'Amount (USD)', reference: 'Reference', notes: 'Notes' };
const statusLabels = { new: 'Ready', review: 'Possible duplicate', duplicate: 'Already present', conflict: 'Conflicting reference', invalid: 'Invalid row' };
const PAGE_SIZE = 40;

export function makeImportUI({ currentBook, mutate, notify, dialogError, onSaved }) {
  const dialog = $('#import-dialog');
  const form = $('#import-form');
  const submit = $('#preview-csv');
  const back = $('#csv-back');
  const picker = $('#csv-file');
  const preset = $('#csv-preset');
  const mapping = $('#csv-mapping');
  const previewSection = $('#csv-preview');
  const previewRows = $('#csv-preview-rows');
  const fieldset = $('#mapping-fields');
  let activeFile = null;
  let activePreview = null;
  let previewConfig = null;
  let selected = new Set();
  let page = 0;
  let fetchGeneration = 0;

  const mappingControls = () => [...fieldset.querySelectorAll('select')];

  function config() {
    return {
      columns: Object.fromEntries(mappingControls().map(control => [control.name, control.value])),
      platform: $('#csv-platform').value, account: $('#csv-account').value,
      kind: $('#csv-kind').value, batch: $('#csv-batch').value
    };
  }

  function applyMapping(item) {
    let partial = false;
    for (const select of mappingControls()) {
      if (item.columns[select.name] && !activeFile.header.includes(item.columns[select.name])) partial = true;
      select.value = activeFile.header.includes(item.columns[select.name]) ? item.columns[select.name] : '';
    }
    $('#csv-platform').value = item.platform || '';
    $('#csv-account').value = item.account || '';
    $('#csv-kind').value = item.kind || '';
    $('#csv-mapping-name').value = item.name || '';
    if (partial) dialogError(dialog, new Error('Some saved columns are missing from this file. Check the mapping before previewing.'));
  }

  function setFields(file) {
    const list = currentBook().settings.mappings;
    options(preset, [['', 'Suggested columns'], ...list.map(item => [item.name, item.name])]);
    options($('#csv-kind'), [['', 'Use the mapped column'], ...Object.entries(kinds)]);
    fieldset.replaceChildren(...MAPPING_FIELDS.map(field => {
      const label = el('label', labels[field]);
      const select = el('select');
      select.name = field;
      options(select, [['', 'Do not map'], ...file.header.map(name => [name, name])]);
      label.append(select);
      return label;
    }));
    applyMapping({ columns: suggestMapping(file.header) });
  }

  function clear() {
    fetchGeneration += 1;
    activeFile = null;
    activePreview = null;
    previewConfig = null;
    selected = new Set();
    form.reset();
    fieldset.replaceChildren();
    preset.replaceChildren();
    previewRows.replaceChildren();
    $('#csv-preview-summary').textContent = '';
    $('#csv-filename').textContent = '';
    $('#csv-picker').hidden = false;
    mapping.hidden = true;
    previewSection.hidden = true;
    back.hidden = true;
    submit.hidden = false;
    submit.disabled = true;
    submit.textContent = 'Preview rows';
    report(dialog.querySelector('[data-error]'));
  }

  function returnToMapping() {
    activePreview = null;
    previewConfig = null;
    mapping.hidden = !activeFile;
    $('#csv-picker').hidden = false;
    previewSection.hidden = true;
    previewRows.replaceChildren();
    back.hidden = true;
    submit.hidden = false;
    submit.disabled = !activeFile;
    submit.textContent = 'Preview rows';
    report(dialog.querySelector('[data-error]'));
  }

  function updateSummary() {
    const { rows, blocked, batchConflict } = activePreview;
    const counts = Object.fromEntries(Object.keys(statusLabels).map(status => [status, 0]));
    for (const row of rows) counts[row.status] += 1;
    const summary = Object.entries(counts).filter(([, count]) => count).map(([status, count]) => count + ' ' + statusLabels[status].toLowerCase()).join(' · ');
    $('#csv-preview-summary').textContent = (blocked ? 'Resolve the issues before saving. ' : selected.size + ' selected. ') + summary +
      (batchConflict ? '. This batch reference was already saved with different contents.' : '.');
    submit.textContent = selected.size ? 'Import ' + selected.size + (selected.size === 1 ? ' record' : ' records') : 'Finish review';
  }

  function drawRows() {
    const table = el('table');
    const head = el('thead');
    const headings = el('tr');
    for (const title of ['Include', 'Row', 'Record', 'Amount', 'Review']) {
      const th = el('th', title);
      th.scope = 'col';
      headings.append(th);
    }
    head.append(headings);
    const body = el('tbody');
    for (const row of activePreview.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const tr = el('tr');
      const pick = el('td');
      const { data } = row;
      if (['new', 'review'].includes(row.status) && !activePreview.blocked) {
        const check = el('input');
        check.type = 'checkbox';
        check.checked = selected.has(row.line);
        check.setAttribute('aria-label', 'Include row ' + row.line + (row.status === 'review' ? ' as a separate record' : ''));
        check.addEventListener('change', () => {
          if (check.checked) selected.add(row.line);
          else selected.delete(row.line);
          updateSummary();
        });
        pick.append(check);
      }
      const record = el('td', data ? kinds[data.kind] + ' · ' + data.date + ' · ' + data.category : '—');
      if (data) record.append(el('small', data.platform + (data.account ? ' · ' + data.account : '') + ' · ' + data.reference +
        (data.notes ? '\n' + data.notes : '')));
      const status = el('td', statusLabels[row.status]);
      if (row.issue) status.append(el('small', row.issue));
      if (row.status === 'review') status.append(el('small', 'Similar to ' + row.comparison.reference + '. Select only if separate.'));
      if (row.status === 'conflict') status.append(el('small', 'This reference has different saved details.'));
      tr.append(pick, el('td', String(row.line)), record, el('td', data ? money(data.cents) : '—'), status);
      body.append(tr);
    }
    table.append(head, body);
    previewRows.replaceChildren(table);
    const pages = Math.ceil(activePreview.rows.length / PAGE_SIZE);
    if (pages > 1) {
      const controls = el('div', undefined, 'pagination');
      const previous = button('Previous rows', 'secondary', () => { page -= 1; drawRows(); previewRows.focus(); });
      const next = button('Next rows', 'secondary', () => { page += 1; drawRows(); previewRows.focus(); });
      previous.disabled = page === 0;
      next.disabled = page === pages - 1;
      controls.append(previous, el('span', 'Page ' + (page + 1) + ' of ' + pages), next);
      previewRows.append(controls);
    }
    previewRows.scrollTop = 0;
  }

  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    const generation = ++fetchGeneration;
    activeFile = null;
    returnToMapping();
    if (!file) return;
    try {
      const text = await readLocalFile(file, CSV_BYTES);
      if (!dialog.open || generation !== fetchGeneration) return;
      activeFile = readCsv(text);
      setFields(activeFile);
      $('#csv-filename').textContent = file.name + ' · ' + activeFile.rows.length + ' data rows';
      mapping.hidden = false;
      submit.disabled = false;
    } catch (error) {
      if (generation === fetchGeneration) dialogError(dialog, error);
    }
  });

  preset.addEventListener('change', () => {
    report(dialog.querySelector('[data-error]'));
    const saved = currentBook().settings.mappings.find(item => item.name === preset.value);
    applyMapping(saved || { columns: suggestMapping(activeFile.header) });
  });

  back.addEventListener('click', () => { returnToMapping(); preset.focus(); });
  dialog.addEventListener('close', () => { if (!dialog.open) clear(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    during(form, async () => {
      if (!activeFile) return;
      report(dialog.querySelector('[data-error]'));
      if (activePreview) {
        if (activePreview.blocked) return;
        const file = activeFile;
        const mappingConfig = previewConfig;
        const choices = new Set(selected);
        const name = $('#csv-mapping-name').value;
        const result = await mutate(book => commitImport(book, file, mappingConfig, choices, name));
        if (!dialog.open) return;
        dialog.close();
        onSaved();
        notify(result.message);
        return;
      }
      const candidate = config();
      const generation = fetchGeneration;
      const preview = await makePreview(currentBook(), activeFile, candidate);
      if (!dialog.open || generation !== fetchGeneration) return;
      activePreview = preview;
      previewConfig = candidate;
      page = 0;
      selected = new Set(preview.rows.filter(row => row.status === 'new').map(row => row.line));
      updateSummary();
      drawRows();
      mapping.hidden = true;
      $('#csv-picker').hidden = true;
      previewSection.hidden = false;
      back.hidden = false;
      submit.hidden = preview.blocked;
      $('#csv-review-title').focus();
    }, error => dialogError(dialog, error));
  });

  return { clear, open() { clear(); dialog.showModal(); picker.focus(); } };
}
