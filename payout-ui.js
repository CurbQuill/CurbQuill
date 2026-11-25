import { confirmedBalances, decimal, money, parseAmount, reviewFacts, sameAccount, saveReview, summarize } from './model.js';
import { $, button, dateLabel, during, el, empty, metricNodes, options } from './ui.js';

const names = { open: 'Needs explanation', pending: 'Pending review', confirmed: 'Matched' };
const LIMIT = 30;

export function makePayoutUI({ currentBook, mutate, notify, dialogError, showEntry }) {
  const dialog = $('#match-dialog');
  const form = $('#match-form');
  const body = $('#match-body');
  const actions = $('#match-actions');
  const statusFilter = $('#payout-status-filter');
  let payoutLimit = LIMIT;
  let earningLimit = LIMIT;
  let activeId = null;

  function summaryItem(row, cents, status, action) {
    const item = el('div', undefined, 'item');
    const left = el('div');
    const right = el('div', undefined, 'side');
    left.append(el('strong', row.platform), el('small', dateLabel(row.date) + (row.account ? ' · ' + row.account : '')),
      el('small', row.reference));
    if (status) left.append(el('span', status[0], 'badge ' + status[1]));
    right.append(el('p', money(cents), 'amount'), action);
    item.append(left, right);
    return item;
  }

  function render() {
    const book = currentBook();
    if (!book) return;
    const payouts = book.rows.filter(row => row.kind === 'payout').sort((a, b) => b.date.localeCompare(a.date));
    const reviews = new Map(book.reviews.map(review => [review.payoutId, review]));
    const balances = confirmedBalances(book);
    const outstanding = book.rows.filter(row => row.kind === 'income' && balances.get(row.id) > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
    const unsettled = outstanding.reduce((total, row) => total + balances.get(row.id), 0);
    const unresolved = payouts.filter(row => reviews.get(row.id)?.state !== 'confirmed');
    const total = summarize(payouts);
    $('#payout-metrics').replaceChildren(...metricNodes([
      ['Payouts received', total.payouts, payouts.length + ' receipts', 'cash'],
      ['Matched cash', total.payouts - summarize(unresolved).payouts, 'Confirmed payouts', 'accent'],
      ['Cash needing review', summarize(unresolved).payouts, 'Includes pending reviews'],
      ['Unsettled earnings', unsettled, 'Expected earnings still open']
    ]));
    $('#payout-notice').hidden = unresolved.length === 0;
    const visible = payouts.filter(row => !statusFilter.value || (reviews.get(row.id)?.state || 'open') === statusFilter.value);
    const receiptList = $('#payout-list');
    receiptList.classList.remove('empty');
    receiptList.replaceChildren(...visible.slice(0, payoutLimit).map(row => {
      const state = reviews.get(row.id)?.state || 'open';
      const action = button(state === 'open' ? 'Match' : 'Review', 'text', () => open(row.id));
      action.setAttribute('aria-label', (state === 'open' ? 'Match payout ' : 'Review payout ') + row.reference);
      return summaryItem(row, row.cents, [names[state], state], action);
    }));
    if (!visible.length) empty(receiptList, 'No payouts to show', payouts.length ? 'Choose a different status.' : 'Record your first payout when cash arrives.');
    if (visible.length > payoutLimit) receiptList.append(button('Show more payouts', 'secondary', () => { payoutLimit += LIMIT; render(); }));
    const unsettledList = $('#outstanding-list');
    unsettledList.classList.remove('empty');
    unsettledList.replaceChildren(...outstanding.slice(0, earningLimit).map(row => {
      const remaining = balances.get(row.id);
      const action = button('View record', 'text', () => showEntry(row.kind, row));
      action.setAttribute('aria-label', 'View earning ' + row.reference);
      const entry = summaryItem(row, remaining, [remaining < row.cents ? 'Partly settled' : 'Unmatched', 'pending'], action);
      if (remaining < row.cents) entry.firstChild.append(el('small', money(row.cents - remaining) + ' of ' + money(row.cents) + ' settled'));
      return entry;
    }));
    if (!outstanding.length) empty(unsettledList, 'No unsettled earnings', 'Recorded earnings with a balance appear here.');
    if (outstanding.length > earningLimit) unsettledList.append(button('Show more earnings', 'secondary', () => { earningLimit += LIMIT; render(); }));
  }

  function errorNode() {
    const node = el('p', undefined, 'message error');
    node.hidden = true;
    node.setAttribute('role', 'alert');
    node.dataset.error = '';
    return node;
  }

  function context() {
    const book = currentBook();
    const payout = book.rows.find(row => row.id === activeId);
    const previous = book.reviews.find(review => review.payoutId === activeId);
    return { book, payout, previous };
  }

  function introduction(payout, status) {
    const wrap = el('div', undefined, 'related-summary');
    wrap.append(el('strong', money(payout.cents) + ' received'), el('p', payout.platform +
      (payout.account ? ' · ' + payout.account : '') + ' · ' + dateLabel(payout.date) + ' · ' + payout.reference, 'muted'));
    if (payout.notes) wrap.append(el('p', payout.notes));
    if (status) wrap.append(el('span', names[status], 'badge ' + status));
    return wrap;
  }

  function previewNode(payout, gross, fee, net, difference) {
    const wrap = el('div', undefined, 'match-summary');
    const scores = el('div', undefined, 'metrics');
    scores.append(...metricNodes([
      ['Cash received', payout.cents], ['Gross allocated', gross], ['Recorded fee', fee],
      ['Unexplained difference', difference, difference < 0 ? 'Proposed net exceeds cash' : '', 'accent']
    ]));
    wrap.append(scores, el('p', 'Proposed net ' + money(net) + '. Recorded income and spending stay the same.', 'muted'));
    return wrap;
  }

  function savedDetails(book, payout, review) {
    const section = el('section');
    const rows = new Map(book.rows.map(row => [row.id, row]));
    const gross = review.allocations.reduce((sum, link) => sum + link.cents, 0);
    const fee = rows.get(review.feeId);
    const net = gross - (fee?.cents || 0);
    section.append(previewNode(payout, gross, fee?.cents || 0, net, payout.cents - net));
    if (review.state === 'pending') section.append(el('p', 'Pending allocations are proposals. They do not settle earnings until confirmed.', 'message'));
    const links = el('ul');
    for (const link of review.allocations) {
      const earning = rows.get(link.earningId);
      links.append(el('li', earning.reference + ' · ' + dateLabel(earning.date) + ' · ' + money(link.cents)));
    }
    if (fee) links.append(el('li', 'Platform fee expense · ' + fee.reference + ' · ' + money(fee.cents)));
    if (links.children.length) section.append(links);
    return section;
  }

  function historyNode(book, payout) {
    const history = book.history.filter(event => event.id === payout.id && event.kind === 'Payout review').reverse();
    const details = el('details');
    details.append(el('summary', 'Review history'));
    const list = el('ul');
    for (const event of history) list.append(el('li', 'Revision ' + event.after.revision + ' · ' + names[event.after.state] +
      ' · ' + new Date(event.at).toLocaleString() + (event.reason ? ' · ' + event.reason : '')));
    details.append(list);
    return details;
  }

  function readView() {
    const { book, payout, previous } = context();
    $('#match-title').textContent = 'Payout review';
    body.replaceChildren(introduction(payout, previous.state), savedDetails(book, payout, previous), historyNode(book, payout), errorNode());
    actions.replaceChildren(
      button('Edit payout record', 'secondary', () => { dialog.close(); showEntry('payout', payout); }),
      button('Revise review', 'primary', () => editor(true)));
  }

  function editor(revision = false) {
    const { book, payout, previous } = context();
    const balances = confirmedBalances(book);
    for (const allocation of previous?.state === 'confirmed' ? previous.allocations : []) {
      balances.set(allocation.earningId, balances.get(allocation.earningId) + allocation.cents);
    }
    const chosen = new Set(previous?.allocations.map(link => link.earningId) || []);
    const earnings = book.rows.filter(row => row.kind === 'income' && sameAccount(row, payout) &&
      (balances.get(row.id) > 0 || chosen.has(row.id))).sort((a, b) => b.date.localeCompare(a.date));
    const usedFees = new Set(book.reviews.filter(item => item.state === 'confirmed' && item.payoutId !== payout.id).map(item => item.feeId));
    const fees = book.rows.filter(row => row.kind === 'expense' && row.category === 'Platform fee' &&
      sameAccount(row, payout) && (!usedFees.has(row.id) || row.id === previous?.feeId));
    const allocationWrap = el('div', undefined, 'match-links');
    const metricWrap = el('div');
    const feeControl = el('select');
    options(feeControl, [['', 'No fee'], ...fees.map(row => [row.id, row.reference + ' · ' + money(row.cents)])], previous?.feeId || '');
    const feeLabel = el('label', 'Recorded fee expense');
    feeLabel.append(feeControl);

    function addLine(selected = '', cents = 0) {
      const line = el('div', undefined, 'allocation');
      const earningLabel = el('label', 'Earning');
      const amountLabel = el('label', 'Allocate (USD)');
      const earningSelect = el('select');
      const amountInput = el('input');
      amountInput.inputMode = 'decimal';
      amountInput.placeholder = '0.00';
      amountInput.maxLength = 10;
      amountInput.value = cents ? decimal(cents) : '';
      options(earningSelect, [['', 'Choose an earning'], ...earnings.map(row => [row.id,
        row.reference + ' · ' + dateLabel(row.date) + ' · ' + money(balances.get(row.id)) + ' available'])], selected);
      earningLabel.append(earningSelect);
      amountLabel.append(amountInput);
      line.append(earningLabel, amountLabel, button('Remove', 'text', () => { line.remove(); calculate(); addLineControl.focus(); }));
      allocationWrap.append(line);
      return earningSelect;
    }

    function raw(state) {
      return { state, allocations: [...allocationWrap.children].flatMap(line => {
        const earningId = line.querySelector('select').value;
        const amount = line.querySelector('input').value.trim();
        if (!earningId && !amount) return [];
        return [{ earningId, cents: parseAmount(amount) }];
      }), feeId: feeControl.value || null };
    }

    function calculate() {
      dialogError(dialog);
      try {
        const input = raw('pending');
        if (!input.allocations.length && !input.feeId) {
          metricWrap.replaceChildren(previewNode(payout, 0, 0, 0, payout.cents));
          return;
        }
        const result = reviewFacts(book, payout.id, input);
        metricWrap.replaceChildren(previewNode(payout, result.gross, result.gross - result.net, result.net, result.difference));
      } catch (error) {
        metricWrap.replaceChildren(el('p', error.message, 'message warning'));
      }
    }

    const addLineControl = button('Add earning', 'secondary', () => addLine().focus());
    addLineControl.disabled = !earnings.length;
    const reasonControl = el('input');
    reasonControl.maxLength = 240;
    const reasonLabel = el('label', 'Revision reason');
    reasonLabel.append(reasonControl);
    const expected = previous?.revision || 0;

    function persist(state) {
      during(form, async () => {
        dialogError(dialog);
        const draft = state === 'open' ? { state, allocations: [], feeId: null } : raw(state);
        const result = await mutate(next => saveReview(next, payout.id, expected, draft, reasonControl.value));
        if (!dialog.open) return;
        dialog.close();
        render();
        notify(result.message);
        const actionLabel = (state === 'open' ? 'Match payout ' : 'Review payout ') + payout.reference;
        const focusReturn = [...$('#payout-list').querySelectorAll('button')].find(node => node.getAttribute('aria-label') === actionLabel);
        (focusReturn || $('#add-payout')).focus();
      }, error => dialogError(dialog, error));
    }

    $('#match-title').textContent = revision ? 'Revise payout review' : 'Match payout';
    body.replaceChildren(introduction(payout, previous?.state || 'open'),
      el('p', 'Choose earnings from this account. Enter only the share covered by this payout.', 'form-note'),
      allocationWrap, addLineControl, el('p', 'For a supported fee, first record a Platform fee expense and select it here.', 'form-note'),
      feeLabel, metricWrap);
    if (!earnings.length) body.append(el('p', 'There are no available earnings for this source account. Record the earnings separately when you have their details.', 'message'));
    if (revision) body.append(reasonLabel);
    body.append(errorNode());
    actions.replaceChildren();
    if (revision) actions.append(button('Reopen without links', 'secondary', () => persist('open')));
    else actions.append(button('Edit payout record', 'secondary', () => { dialog.close(); showEntry('payout', payout); }));
    actions.append(button('Save pending review', 'secondary', () => persist('pending')),
      button('Confirm match', 'primary', () => persist('confirmed')));
    allocationWrap.addEventListener('input', calculate);
    feeControl.addEventListener('change', calculate);
    for (const allocation of previous?.allocations || []) addLine(allocation.earningId, allocation.cents);
    if (!allocationWrap.children.length && earnings.length) addLine();
    calculate();
    if (dialog.open) (allocationWrap.querySelector('select') || feeControl).focus();
  }

  function open(id) {
    activeId = id;
    const saved = currentBook().reviews.find(review => review.payoutId === id);
    if (saved && saved.state !== 'open') readView();
    else editor();
    dialog.showModal();
    (body.querySelector('select') || actions.querySelector('button')).focus();
  }

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    body.replaceChildren();
    actions.replaceChildren();
    activeId = null;
  });
  form.addEventListener('submit', event => event.preventDefault());
  statusFilter.addEventListener('change', () => { payoutLimit = LIMIT; render(); });

  return {
    render,
    clear() {
      activeId = null;
      payoutLimit = LIMIT;
      earningLimit = LIMIT;
      statusFilter.value = '';
      for (const node of [$('#payout-metrics'), $('#payout-list'), $('#outstanding-list'), body, actions]) node.replaceChildren();
    }
  };
}
