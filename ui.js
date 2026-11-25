import { money } from './model.js';

export const $ = selector => document.querySelector(selector);
export const $$ = selector => Array.from(document.querySelectorAll(selector));
export const dateLabel = date => new Date(date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function el(tag, text, classes) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (classes) node.className = classes;
  return node;
}

export function button(label, classes, action) {
  const node = el('button', label, classes);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function options(select, items, selected = '') {
  select.replaceChildren(...items.map(([value, label]) => new Option(label, value)));
  if (items.some(([value]) => value === selected)) select.value = selected;
}

export function report(node, text = '', error = false) {
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle('error', error);
}

export function metricNodes(items) {
  return items.map(([caption, amount, detail, classes = '']) => {
    const metric = el('div', undefined, ('metric ' + classes).trim());
    metric.append(el('span', caption), el('strong', money(amount)));
    if (detail) metric.append(el('small', detail));
    return metric;
  });
}

export function empty(node, title, body) {
  node.replaceChildren(el('strong', title), el('p', body));
  node.classList.add('empty');
  node.hidden = false;
}

export async function during(form, action, onError) {
  if (form.dataset.busy) return;
  form.dataset.busy = 'true';
  const buttons = [...form.querySelectorAll('button:not(:disabled)')];
  buttons.forEach(control => { control.disabled = true; });
  try {
    await action();
  } catch (error) {
    onError(error);
  } finally {
    delete form.dataset.busy;
    buttons.forEach(control => { control.disabled = false; });
  }
}
