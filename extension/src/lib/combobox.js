// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Searchable combobox component (FMN-88).
//
// Replaces the native <select> in places where the option list is too long
// to scroll efficiently. Pure JS, no framework. Two modes:
//
//   allowFreeText=false  - operator must pick an item from the list. Used
//                          where the underlying value is opaque (e.g., a
//                          resource URL) and only the catalog can supply
//                          it.
//
//   allowFreeText=true   - operator may type free text not in the list.
//                          Used where the picker's role is advisory and
//                          the caller can still resolve a name typed by
//                          hand (e.g., Search Servers, where built-in
//                          attribute names are sometimes missing from the
//                          catalog response).
//
// Filtering is case-insensitive substring match against label and hint.

import { h, clear } from './dom.js';

/**
 * Pure filter used by createCombobox. Exported for tests.
 *
 * @param {Array<{label:string, hint?:string}>} items
 * @param {string} query
 * @returns {Array} subset of `items` whose label or hint contains `query` (case-insensitive).
 */
export function filterItems(items, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter((it) => {
    const a = String(it.label ?? '').toLowerCase();
    const b = String(it.hint ?? '').toLowerCase();
    return a.includes(q) || b.includes(q);
  });
}

export function createCombobox({
  items = [],
  initialValue = null,
  initialText = '',
  placeholder = '',
  allowFreeText = false,
  onChange = () => {},
  emptyText = 'No matches'
} = {}) {
  let _items = items.slice();
  let _selected = initialValue != null
    ? (_items.find((i) => i.value === initialValue) || null)
    : null;
  // _filterText === null means "show selected label"; a string means
  // "operator is filtering / typing".
  let _filterText = null;
  let _highlightIndex = 0;
  let _disabled = false;

  if (allowFreeText && !_selected && initialText) {
    _filterText = initialText;
  }

  const input = h('input', {
    type: 'text',
    class: 'combobox-input',
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false'
  });
  const list = h('ul', { class: 'combobox-list', hidden: true, role: 'listbox' });
  const wrapper = h('div', { class: 'combobox' }, input, list);

  function visibleText() {
    if (_filterText !== null) return _filterText;
    if (_selected) return _selected.label;
    return '';
  }

  function syncInputText() {
    input.value = visibleText();
  }

  function getFiltered() {
    return filterItems(_items, _filterText ?? '');
  }

  function renderList() {
    clear(list);
    const filtered = getFiltered();
    if (filtered.length === 0) {
      list.appendChild(h('li', { class: 'combobox-empty' }, emptyText));
      return;
    }
    if (_highlightIndex >= filtered.length) _highlightIndex = filtered.length - 1;
    if (_highlightIndex < 0) _highlightIndex = 0;
    filtered.forEach((it, i) => {
      const labelNode = h('span', { class: 'combobox-label' }, it.label);
      const hintNode = it.hint && it.hint !== it.label
        ? h('span', { class: 'combobox-hint' }, it.hint)
        : null;
      const li = h('li', {
        class: `combobox-item${i === _highlightIndex ? ' highlighted' : ''}`,
        role: 'option',
        dataset: { value: String(it.value), index: String(i) }
      }, labelNode, hintNode);
      // mousedown so it fires before the input's blur handler runs.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectItem(it);
      });
      li.addEventListener('mouseenter', () => {
        _highlightIndex = i;
        for (const node of list.children) node.classList.remove('highlighted');
        li.classList.add('highlighted');
      });
      list.appendChild(li);
    });
  }

  function open() {
    if (_disabled) return;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    renderList();
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    if (!allowFreeText) {
      _filterText = null;
      syncInputText();
    }
  }

  function selectItem(item) {
    _selected = item;
    _filterText = allowFreeText ? item.label : null;
    syncInputText();
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    onChange(item.value, item, input.value);
  }

  function commitFreeText() {
    if (!allowFreeText) return;
    const text = input.value;
    _selected = null;
    _filterText = text;
    onChange(null, null, text);
  }

  input.addEventListener('focus', () => {
    if (_disabled) return;
    if (allowFreeText) {
      _filterText = input.value;
    } else {
      _filterText = '';
      // Select-all so a keystroke replaces the displayed label.
      input.select();
    }
    open();
  });

  input.addEventListener('blur', () => {
    // Defer slightly so an in-flight item click can register first.
    setTimeout(() => {
      if (list.hidden) return;
      if (allowFreeText) commitFreeText();
      close();
    }, 120);
  });

  input.addEventListener('input', () => {
    _filterText = input.value;
    _highlightIndex = 0;
    open();
    if (allowFreeText) {
      _selected = null;
      onChange(null, null, _filterText);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const filtered = getFiltered();
      if (filtered.length === 0) return;
      _highlightIndex = (_highlightIndex + 1) % filtered.length;
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const filtered = getFiltered();
      if (filtered.length === 0) return;
      _highlightIndex = (_highlightIndex - 1 + filtered.length) % filtered.length;
      renderList();
    } else if (e.key === 'Enter') {
      const filtered = getFiltered();
      const target = filtered[_highlightIndex];
      if (target) {
        e.preventDefault();
        selectItem(target);
      } else if (allowFreeText) {
        e.preventDefault();
        commitFreeText();
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      input.blur();
    } else if (e.key === 'Tab') {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  });

  function onDocumentMousedown(e) {
    if (!wrapper.contains(e.target) && !list.hidden) {
      if (allowFreeText) commitFreeText();
      close();
    }
  }
  document.addEventListener('mousedown', onDocumentMousedown);

  syncInputText();

  return {
    element: wrapper,
    input,
    setItems(newItems) {
      _items = newItems.slice();
      if (_selected) {
        const next = _items.find((i) => i.value === _selected.value);
        _selected = next || null;
      }
      syncInputText();
      if (!list.hidden) renderList();
    },
    setValue(value, { silent = false } = {}) {
      const next = _items.find((i) => i.value === value) || null;
      _selected = next;
      _filterText = null;
      syncInputText();
      if (!silent) onChange(_selected?.value ?? null, _selected, input.value);
    },
    setText(text, { silent = false } = {}) {
      if (!allowFreeText) return;
      _selected = null;
      _filterText = text;
      input.value = text;
      if (!silent) onChange(null, null, text);
    },
    getValue() { return _selected?.value ?? null; },
    getText() { return input.value; },
    getItem() { return _selected; },
    setDisabled(d) {
      _disabled = !!d;
      input.disabled = !!d;
      if (d) close();
    },
    setPlaceholder(p) {
      input.setAttribute('placeholder', p ?? '');
    },
    destroy() {
      document.removeEventListener('mousedown', onDocumentMousedown);
    }
  };
}
