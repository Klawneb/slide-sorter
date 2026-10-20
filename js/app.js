import * as db from './db.js';
import { makeZip } from './zip.js';

const $ = id => document.getElementById(id);

const THUMB_SIZE = 400;
const TILE_SIZES = [110, 150, 200];
const canPickFolder = 'showDirectoryPicker' in window;

// id -> { id, name, size, lastModified, type, order, blob, thumb }
const photos = new Map();
// The arrangement. `order` on each photo is its import position, which is
// how Unsorted stays sorted. `removed` holds photos taken out of the project
// (kept until the next launch so Remove can be undone).
let state = { unsorted: [], groups: [], removed: [], nextOrder: 0 };
let selection = []; // photo ids, in the order they were tapped
const undoStack = [];
const thumbUrls = new Map();
const tiles = new Map();

// ---------- State helpers ----------

const findGroup = id => state.groups.find(g => g.id === id);
const byOrder = (a, b) => photos.get(a).order - photos.get(b).order;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const fileKey = f => `${f.name}|${f.size}|${f.lastModified}`;

function locate(id) {
  if (state.unsorted.includes(id)) return { group: null, list: state.unsorted };
  for (const g of state.groups) if (g.photoIds.includes(id)) return { group: g, list: g.photoIds };
  return null;
}

function takeOut(ids) {
  const set = new Set(ids);
  state.unsorted = state.unsorted.filter(id => !set.has(id));
  for (const g of state.groups) g.photoIds = g.photoIds.filter(id => !set.has(id));
}

// Make the state consistent with the photos we actually have: drop unknown
// ids and put any photo that isn't anywhere back into Unsorted.
function normalize() {
  const seen = new Set();
  const keep = id => photos.has(id) && !seen.has(id) && seen.add(id);
  state.removed = state.removed.filter(keep);
  for (const g of state.groups) g.photoIds = g.photoIds.filter(keep);
  state.unsorted = state.unsorted.filter(keep);
  for (const id of photos.keys()) if (!seen.has(id)) state.unsorted.push(id);
  state.unsorted.sort(byOrder);
  for (const p of photos.values()) state.nextOrder = Math.max(state.nextOrder, p.order + 1);
}

// Every user edit goes through here so it can be undone.
function change(fn) {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 100) undoStack.shift();
  fn();
  persist();
  render();
}

function undo() {
  if (!undoStack.length) return;
  state = JSON.parse(undoStack.pop());
  normalize();
  selection = selection.filter(id => locate(id));
  persist();
  render();
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  db.saveState(state).catch(err => console.error('Saving failed', err));
}

// ---------- Rendering ----------

function thumbUrl(p) {
  if (!thumbUrls.has(p.id)) thumbUrls.set(p.id, URL.createObjectURL(p.thumb || p.blob));
  return thumbUrls.get(p.id);
}

function tileFor(id) {
  let el = tiles.get(id);
  if (el) return el;
  const p = photos.get(id);
  el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = id;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = p.name;
  img.src = thumbUrl(p);
  el.innerHTML = '<span class="badge"></span><span class="position"></span>' +
    '<button class="zoom" aria-label="View larger">⤢</button>';
  el.prepend(img);
  tiles.set(id, el);
  return el;
}

function updateTile(el, position) {
  const n = selection.indexOf(el.dataset.id);
  el.classList.toggle('selected', n >= 0);
  el.querySelector('.badge').textContent = n >= 0 ? n + 1 : '';
  el.querySelector('.position').textContent = position || '';
}

function slot(groupId, index, wide = false) {
  const b = document.createElement('button');
  b.className = 'slot' + (wide ? ' slot-wide' : '');
  b.dataset.group = groupId;
  b.dataset.index = index;
  b.textContent = wide ? '⬇ Put the selected photos here' : '⬇';
  b.setAttribute('aria-label', 'Put the selected photos here');
  return b;
}

function empty(text) {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  return d;
}

function el(tag, attrs = {}, text = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function render() {
  const selecting = selection.length > 0;

  // Unsorted pane
  const ub = $('unsorted-body');
  const uScroll = ub.scrollTop;
  if (state.unsorted.length) {
    const grid = el('div', { class: 'grid' });
    for (const id of state.unsorted) {
      const t = tileFor(id);
      updateTile(t);
      grid.append(t);
    }
    ub.replaceChildren(grid);
  } else {
    ub.replaceChildren(empty(photos.size - state.removed.length > 0
      ? 'Every photo is in a group. When you\'re happy with the order, tap Export.'
      : 'Tap “＋ Add photos” to choose the scanned photos you want to sort.'));
  }
  ub.scrollTop = uScroll;
  $('unsorted-count').textContent = `(${state.unsorted.length})`;

  // Groups pane
  const gb = $('groups-body');
  const gScroll = gb.scrollTop;
  const sections = state.groups.map((g, gi) => {
    const section = el('section', { class: 'group' + (g.collapsed ? ' collapsed' : ''), 'data-group': g.id });
    const header = el('div', { class: 'group-header' });
    const name = el('button', { class: 'group-name', 'data-action': 'toggle', 'aria-expanded': String(!g.collapsed) });
    name.append(el('span', { class: 'num' }, `${g.collapsed ? '▸' : '▾'} ${gi + 1}.`),
      document.createTextNode(g.name),
      el('span', { class: 'count' }, `(${g.photoIds.length})`));
    header.append(name);
    for (const [action, label, aria, disabled] of [
      ['up', '▲', 'Move group up', gi === 0],
      ['down', '▼', 'Move group down', gi === state.groups.length - 1],
      ['rename', '✎', 'Rename group', false],
      ['delete', '🗑', 'Delete group', false],
    ]) {
      const b = el('button', { class: 'btn btn-small', 'data-action': action, 'aria-label': aria }, label);
      b.disabled = disabled;
      header.append(b);
    }
    section.append(header);

    const body = el('div', { class: 'group-body' });
    if (g.photoIds.length) {
      const grid = el('div', { class: 'grid' });
      g.photoIds.forEach((id, i) => {
        if (selecting) grid.append(slot(g.id, i));
        const t = tileFor(id);
        updateTile(t, i + 1);
        grid.append(t);
      });
      if (selecting) grid.append(slot(g.id, g.photoIds.length));
      body.append(grid);
    } else if (selecting) {
      body.append(slot(g.id, 0, true));
    } else {
      body.append(empty('No photos yet. Tap photos to select them, then tap “Add to group…”.'));
    }
    section.append(body);
    return section;
  });
  gb.replaceChildren(...(sections.length ? sections
    : [empty('No groups yet. Tap “＋ New group” to make one, e.g. “Christmas 1980”.')]));
  gb.scrollTop = gScroll;
  const grouped = state.groups.reduce((n, g) => n + g.photoIds.length, 0);
  $('groups-count').textContent = state.groups.length
    ? `(${state.groups.length} · ${grouped} photo${grouped === 1 ? '' : 's'})` : '';

  // Toolbar and action bar
  $('btn-undo').disabled = undoStack.length === 0;
  $('action-bar').hidden = !selecting;
  if (selecting) {
    $('selected-count').textContent = `${selection.length} photo${selection.length === 1 ? '' : 's'} selected`;
    $('btn-to-unsorted').hidden = selection.every(id => !locate(id)?.group);
  }
  if (!$('viewer').hidden) updateViewer();
}

function applyTileSize() {
  const size = Number(localStorage.getItem('tileSize')) || TILE_SIZES[1];
  document.documentElement.style.setProperty('--tile', size + 'px');
}

// ---------- Dialogs ----------

// Called when the dialog is closed with Esc or the back gesture. The close
// event fires asynchronously, so it is ignored if another dialog has since
// been opened.
let dismissDialog = null;
$('dialog').addEventListener('close', () => {
  if (!$('dialog').open) dismissDialog?.();
});

// Shows a modal. Resolves to the clicked button's value (or { value, text }
// when there is a text input), or null if dismissed.
function ask({ title, message = '', input = null, buttons, stacked = false }) {
  const dialog = $('dialog');
  $('dialog-title').textContent = title;
  const msg = $('dialog-message');
  msg.replaceChildren();
  if (message instanceof Node) msg.append(message);
  else msg.textContent = message;

  const field = $('dialog-input');
  field.hidden = !input;
  if (input) {
    field.value = input.value || '';
    field.placeholder = input.placeholder || '';
  }

  const box = $('dialog-buttons');
  box.className = 'dialog-buttons' + (stacked ? ' dialog-list' : ' inline');
  box.replaceChildren();

  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      dialog.close();
      resolve(value);
    };
    let primary = null;
    for (const b of buttons) {
      const btn = el('button', { type: 'button', class: 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : '') }, b.label);
      btn.addEventListener('click', () => {
        if (b.value == null) return finish(null);
        if (input) {
          const text = field.value.trim();
          if (!text) return field.focus();
          return finish({ value: b.value, text });
        }
        finish(b.value);
      });
      if (b.primary) primary = btn;
      box.append(btn);
    }
    $('dialog-form').onsubmit = e => { e.preventDefault(); primary?.click(); };
    dismissDialog = () => finish(null);
    dialog.showModal();
    if (input) {
      field.focus();
      field.select();
    }
  });
}

const tell = (title, message) => ask({ title, message, buttons: [{ label: 'OK', value: true, primary: true }] });
const confirmIt = (title, message, yes, danger = false) => ask({
  title, message, buttons: [{ label: 'Cancel' }, { label: yes, value: true, primary: !danger, danger }],
});

function showProgress(text, done = 0, total = 1) {
  $('progress').hidden = false;
  $('progress-text').textContent = text;
  $('progress-bar').style.width = `${total ? (100 * done) / total : 0}%`;
}
const hideProgress = () => { $('progress').hidden = true; };

// ---------- Importing ----------

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif|tiff?|avif)$/i;
const isImage = f => f.type.startsWith('image/') || IMAGE_EXT.test(f.name);

async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_SIZE / Math.min(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
  } catch {
    return null; // the browser can't decode it; the tile falls back to the original
  }
}

async function importFiles(files) {
  files = files.filter(isImage);
  if (!files.length) return tell('No photos found', 'None of the chosen files look like photos.');

  const existing = new Map([...photos.values()].map(p => [fileKey(p), p.id]));
  const removed = new Set(state.removed);
  const restored = [];
  const fresh = [];
  for (const f of files) {
    const id = existing.get(fileKey(f));
    if (id === undefined) fresh.push(f);
    else if (removed.has(id)) restored.push(id);
  }
  const skipped = files.length - fresh.length - restored.length;

  // Scan order is the best first guess at the right order.
  fresh.sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name, undefined, { numeric: true }));

  navigator.storage?.persist?.();
  try {
    for (let i = 0; i < fresh.length; i++) {
      showProgress(`Adding photos… ${i + 1} of ${fresh.length}`, i, fresh.length);
      const f = fresh[i];
      const photo = {
        id: newId(),
        name: f.name,
        size: f.size,
        lastModified: f.lastModified,
        type: f.type,
        order: state.nextOrder++,
        blob: f,
        thumb: await makeThumb(f),
      };
      await db.putPhoto(photo);
      photos.set(photo.id, photo);
      state.unsorted.push(photo.id);
    }
  } catch (err) {
    console.error(err);
    await tell('Couldn\'t add all the photos', `Something went wrong: ${err.message}. The photos added so far have been kept.`);
  } finally {
    hideProgress();
  }

  if (restored.length) {
    state.removed = state.removed.filter(id => !restored.includes(id));
    state.unsorted.push(...restored);
  }
  state.unsorted.sort(byOrder);
  saveNow();
  render();
  if (skipped) tell('Some photos were already here', `${skipped} of the chosen photos had already been added, so they were skipped.`);
}

async function importFolder() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'import', mode: 'read' });
  } catch (err) {
    if (err.name !== 'AbortError') tell('Couldn\'t open the folder', err.message);
    return;
  }
  const files = [];
  for await (const handle of dir.values()) {
    if (handle.kind === 'file') files.push(await handle.getFile());
  }
  await importFiles(files);
}

// ---------- Editing ----------

async function newGroup() {
  const moving = selection.length;
  const res = await ask({
    title: 'New group',
    message: moving ? `The ${moving} selected photo${moving === 1 ? '' : 's'} will go into it.` : '',
    input: { placeholder: 'e.g. Christmas 1980' },
    buttons: [{ label: 'Cancel' }, { label: 'Create group', value: true, primary: true }],
  });
  if (!res) return null;
  const g = { id: newId(), name: res.text, photoIds: [], collapsed: false };
  change(() => {
    state.groups.push(g);
    if (moving) {
      takeOut(selection);
      g.photoIds.push(...selection);
      selection = [];
    }
  });
  document.querySelector(`.group[data-group="${g.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return g;
}

function placeSelection(groupId, index) {
  const g = findGroup(groupId);
  if (!g || !selection.length) return;
  change(() => {
    const moving = new Set(selection);
    const shift = g.photoIds.slice(0, index).filter(id => moving.has(id)).length;
    takeOut(selection);
    g.photoIds.splice(index - shift, 0, ...selection);
    selection = [];
  });
}

async function addSelectionToGroup() {
  const res = await ask({
    title: `Add ${selection.length} photo${selection.length === 1 ? '' : 's'} to…`,
    stacked: true,
    buttons: [
      ...state.groups.map((g, i) => ({ label: `${i + 1}. ${g.name} (${g.photoIds.length})`, value: g.id })),
      { label: '＋ New group', value: '__new', primary: true },
      { label: 'Cancel' },
    ],
  });
  if (res === '__new') return newGroup();
  if (res) placeSelection(res, findGroup(res).photoIds.length);
}

function selectionToUnsorted() {
  change(() => {
    takeOut(selection);
    state.unsorted.push(...selection);
    state.unsorted.sort(byOrder);
    selection = [];
  });
}

async function removeSelection() {
  const n = selection.length;
  const ok = await confirmIt(
    `Remove ${n} photo${n === 1 ? '' : 's'}?`,
    'They will be left out of the export (useful for duplicates or bad scans). The original files on the tablet are not deleted.',
    'Remove', true);
  if (!ok) return;
  change(() => {
    takeOut(selection);
    state.removed.push(...selection);
    selection = [];
  });
}

function toggleSelect(id) {
  const i = selection.indexOf(id);
  if (i >= 0) selection.splice(i, 1);
  else selection.push(id);
  render();
}

async function groupAction(g, action) {
  const i = state.groups.indexOf(g);
  if (action === 'toggle') {
    // Collapsing isn't worth an undo step.
    g.collapsed = !g.collapsed;
    persist();
    render();
  } else if (action === 'up' || action === 'down') {
    const j = action === 'up' ? i - 1 : i + 1;
    change(() => { [state.groups[i], state.groups[j]] = [state.groups[j], state.groups[i]]; });
  } else if (action === 'rename') {
    const res = await ask({
      title: 'Rename group',
      input: { value: g.name },
      buttons: [{ label: 'Cancel' }, { label: 'Save', value: true, primary: true }],
    });
    if (res) change(() => { g.name = res.text; });
  } else if (action === 'delete') {
    const n = g.photoIds.length;
    const ok = await confirmIt(`Delete “${g.name}”?`,
      n ? `Its ${n} photo${n === 1 ? '' : 's'} will go back to Unsorted.` : 'The group is empty.', 'Delete group', true);
    if (ok) change(() => {
      state.groups.splice(i, 1);
      state.unsorted.push(...g.photoIds);
      state.unsorted.sort(byOrder);
    });
  }
}

// ---------- Viewer ----------

let viewing = null;
let viewerUrl = null;

function openViewer(id) {
  viewing = id;
  $('viewer').hidden = false;
  history.pushState({ viewer: true }, '');
  updateViewer();
}

function closeViewer() {
  if ($('viewer').hidden) return;
  $('viewer').hidden = true;
  viewing = null;
  $('viewer-img').removeAttribute('src');
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
}

function updateViewer() {
  const where = viewing && locate(viewing);
  if (!where) return history.back();
  const p = photos.get(viewing);
  const i = where.list.indexOf(viewing);
  const img = $('viewer-img');
  if (img.dataset.id !== viewing) {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(p.blob);
    img.src = viewerUrl;
    img.dataset.id = viewing;
  }
  $('viewer-label').textContent = `${where.group ? where.group.name : 'Unsorted'} · ${i + 1} of ${where.list.length}`;
  $('viewer-prev').disabled = i === 0;
  $('viewer-next').disabled = i === where.list.length - 1;
  const selected = selection.includes(viewing);
  $('viewer-select').textContent = selected ? '✓ Selected' : 'Select';
  $('viewer-select').classList.toggle('btn-primary', selected);
}

function stepViewer(delta) {
  const where = locate(viewing);
  const next = where?.list[where.list.indexOf(viewing) + delta];
  if (next) {
    viewing = next;
    updateViewer();
  }
}

// ---------- Exporting ----------

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/gif': '.gif' };

function extension(p) {
  const m = p.name.match(/\.[a-z0-9]{1,5}$/i);
  return m ? m[0].toLowerCase() : MIME_EXT[p.type] || '.jpg';
}

function cleanName(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '').slice(0, 80) || 'Group';
}

// "01 - Christmas 1980 - 001.jpg": zero-padded so every gallery sorts them
// in this order, even ones that sort "10" before "2".
function exportEntries() {
  const groups = state.groups.filter(g => g.photoIds.length);
  const gPad = Math.max(2, String(groups.length).length);
  const pPad = Math.max(3, ...groups.map(g => String(g.photoIds.length).length));
  return groups.flatMap((g, gi) => g.photoIds.map((id, pi) => {
    const p = photos.get(id);
    const name = `${String(gi + 1).padStart(gPad, '0')} - ${cleanName(g.name)} - ${String(pi + 1).padStart(pPad, '0')}${extension(p)}`;
    return { name, blob: p.blob };
  }));
}

async function exportPhotos() {
  if (selection.length) {
    selection = [];
    render();
  }
  const entries = exportEntries();
  if (!entries.length) return tell('Nothing to export yet', 'Put some photos into groups first.');
  if (state.unsorted.length) {
    const n = state.unsorted.length;
    const ok = await confirmIt('Some photos aren\'t in a group',
      `${n} photo${n === 1 ? ' is' : 's are'} still in Unsorted and will be left out of the export.`, 'Export anyway');
    if (!ok) return;
  }

  const choice = await ask({
    title: `Export ${entries.length} photos`,
    message: canPickFolder
      ? 'Saving into a folder is easiest: make a new, empty folder (for example “Sorted slides” inside Pictures) when asked.'
      : 'The photos will be downloaded as one ZIP file.',
    stacked: true,
    buttons: [
      ...(canPickFolder ? [{ label: 'Save into a folder', value: 'folder', primary: true }] : []),
      { label: 'Download as a ZIP file', value: 'zip', primary: !canPickFolder },
      { label: 'Cancel' },
    ],
  });
  if (choice === 'folder') await exportToFolder(entries);
  else if (choice === 'zip') await exportZip(entries);
}

async function exportToFolder(entries) {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'export', mode: 'readwrite', startIn: 'pictures' });
  } catch (err) {
    if (err.name !== 'AbortError') await offerZipInstead(entries, err);
    return;
  }

  let existing = 0;
  for await (const handle of dir.values()) if (handle.kind === 'file') existing++;
  if (existing) {
    const ok = await confirmIt('This folder isn\'t empty',
      `“${dir.name}” already has ${existing} file${existing === 1 ? '' : 's'} in it. Files with the same names will be replaced. It's best to use a new, empty folder.`,
      'Use it anyway');
    if (!ok) return;
  }

  try {
    for (let i = 0; i < entries.length; i++) {
      showProgress(`Saving photos… ${i + 1} of ${entries.length}`, i, entries.length);
      const file = await dir.getFileHandle(entries[i].name, { create: true });
      const out = await file.createWritable();
      await out.write(entries[i].blob);
      await out.close();
    }
  } catch (err) {
    hideProgress();
    return offerZipInstead(entries, err);
  }
  hideProgress();
  await tell('Done!',
    `${entries.length} photos were saved into “${dir.name}”. Open the Gallery to check them. ` +
    'Once you\'re happy, you can delete the original unsorted scans so you don\'t see every photo twice.');
}

async function offerZipInstead(entries, err) {
  console.error(err);
  const ok = await confirmIt('Couldn\'t save into that folder',
    `${err.message || err}. You can download the photos as a ZIP file instead.`, 'Download ZIP');
  if (ok) await exportZip(entries);
}

async function exportZip(entries) {
  let zip;
  try {
    zip = await makeZip(entries, (done, total) => showProgress(`Preparing ZIP… ${done} of ${total}`, done, total));
  } catch (err) {
    hideProgress();
    return tell('Couldn\'t make the ZIP', err.message);
  }
  hideProgress();
  const url = URL.createObjectURL(zip);
  const a = el('a', { href: url, download: 'Sorted slides.zip' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  await tell('Download started',
    'When it finishes, open the Files app, tap “Sorted slides.zip” and choose Extract. ' +
    'Once you\'re happy with the photos, you can delete the original unsorted scans so you don\'t see every photo twice.');
}

// ---------- Menu ----------

async function showMenu() {
  const size = Number(localStorage.getItem('tileSize')) || TILE_SIZES[1];
  const sizeName = ['Small', 'Medium', 'Large'][TILE_SIZES.indexOf(size)] || 'Medium';
  const allCollapsed = state.groups.length && state.groups.every(g => g.collapsed);
  const choice = await ask({
    title: 'More options',
    stacked: true,
    buttons: [
      ...(canPickFolder ? [{ label: 'Add every photo in a folder', value: 'folder' }] : []),
      { label: `Photo size: ${sizeName} (tap to change)`, value: 'size' },
      ...(state.groups.length ? [{ label: allCollapsed ? 'Open all groups' : 'Close all groups', value: 'collapse' }] : []),
      { label: 'How to use', value: 'help' },
      { label: 'Start over', value: 'reset', danger: true },
      { label: 'Close' },
    ],
  });
  if (choice === 'folder') importFolder();
  else if (choice === 'size') {
    localStorage.setItem('tileSize', TILE_SIZES[(TILE_SIZES.indexOf(size) + 1) % TILE_SIZES.length]);
    applyTileSize();
  } else if (choice === 'collapse') {
    state.groups.forEach(g => { g.collapsed = !allCollapsed; });
    persist();
    render();
  } else if (choice === 'help') showHelp();
  else if (choice === 'reset') startOver();
}

function showHelp() {
  const steps = el('ol');
  for (const text of [
    'Tap “＋ Add photos” and choose the scans. You can add more at any time.',
    'Tap “＋ New group” and give it a name, like “Christmas 1980”.',
    'Tap photos to select them (they get a number), then tap “Add to group…”.',
    'To change the order, select photos in the order you want, then tap a ⬇ where they should go.',
    'Tap ⤢ on a photo to see it bigger. Made a mistake? Tap “↶ Undo”.',
    'Your work is saved as you go. When finished, tap Export.',
  ]) steps.append(el('li', {}, text));
  tell('How to use', steps);
}

async function startOver() {
  const ok = await confirmIt('Start over?',
    'This clears all the groups and photos from Slide Sorter. The original files on the tablet are not deleted.',
    'Clear everything', true);
  if (!ok) return;
  await db.clearAll();
  thumbUrls.forEach(url => URL.revokeObjectURL(url));
  thumbUrls.clear();
  tiles.clear();
  photos.clear();
  state = { unsorted: [], groups: [], removed: [], nextOrder: 0 };
  selection = [];
  undoStack.length = 0;
  render();
}

// ---------- Wiring ----------

function wire() {
  $('btn-add').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) importFiles(files);
  });
  $('btn-new-group').addEventListener('click', newGroup);
  $('btn-undo').addEventListener('click', undo);
  $('btn-export').addEventListener('click', exportPhotos);
  $('btn-menu').addEventListener('click', showMenu);

  $('btn-to-group').addEventListener('click', addSelectionToGroup);
  $('btn-to-unsorted').addEventListener('click', selectionToUnsorted);
  $('btn-remove').addEventListener('click', removeSelection);
  $('btn-clear').addEventListener('click', () => { selection = []; render(); });

  for (const pane of [$('unsorted-body'), $('groups-body')]) {
    pane.addEventListener('click', e => {
      const zoom = e.target.closest('.zoom');
      if (zoom) return openViewer(zoom.closest('.tile').dataset.id);
      const tile = e.target.closest('.tile');
      if (tile) return toggleSelect(tile.dataset.id);
      const s = e.target.closest('.slot');
      if (s) return placeSelection(s.dataset.group, Number(s.dataset.index));
      const action = e.target.closest('[data-action]');
      if (action) groupAction(findGroup(action.closest('.group').dataset.group), action.dataset.action);
    });
  }

  $('viewer-close').addEventListener('click', () => history.back());
  $('viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('viewer-next').addEventListener('click', () => stepViewer(1));
  $('viewer-select').addEventListener('click', () => toggleSelect(viewing));
  // The Android back gesture closes the viewer instead of leaving the app.
  window.addEventListener('popstate', closeViewer);
  let touchX = null;
  $('viewer').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  $('viewer').addEventListener('touchend', e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 60) stepViewer(dx > 0 ? -1 : 1);
  });
  document.addEventListener('keydown', e => {
    if ($('viewer').hidden) return;
    if (e.key === 'ArrowLeft') stepViewer(-1);
    else if (e.key === 'ArrowRight') stepViewer(1);
    else if (e.key === 'Escape') history.back();
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
}

async function init() {
  applyTileSize();
  wire();
  const [records, saved] = await Promise.all([db.getAllPhotos(), db.loadState()]);
  for (const r of records) photos.set(r.id, r);
  if (saved) state = { ...state, ...saved };
  // Removed photos only need keeping for undo, which doesn't survive a reload.
  if (state.removed.length) {
    await db.deletePhotos(state.removed);
    state.removed.forEach(id => photos.delete(id));
    state.removed = [];
  }
  normalize();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
