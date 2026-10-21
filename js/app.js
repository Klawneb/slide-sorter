import * as db from './db.js';
import { makeZip, readZip } from './zip.js';
import { setJpegDate, jpegInfo } from './exif.js';
import { sortTags, yearOf, displayOrder, planExport } from './tags.js';

const $ = id => document.getElementById(id);

const THUMB_SIZE = 400;
const TILE_SIZES = [110, 150, 200, 260];
const TILE_NAMES = ['Small', 'Medium', 'Large', 'Extra large'];
// Big tablets (like a Galaxy Tab Ultra, ~1480px wide) start with large photos.
const tileSize = () => Number(localStorage.getItem('tileSize')) || (Math.max(screen.width, screen.height) >= 1200 ? 200 : 150);
const canPickFolder = 'showDirectoryPicker' in window;

// id -> { id, name, size, lastModified, type, order, blob, thumb }
const photos = new Map();

// Everything the user arranges. `order` is his order of all photos (scan
// order to start with); `photoTags` maps photo id -> tag ids. `removed`
// holds photos taken out, kept until the next launch so Remove can be undone.
const emptyState = () => ({ order: [], tags: [], photoTags: {}, removed: [], nextOrder: 0 });
let state = emptyState();

let view = 'photos';
let selection = [];      // photo ids, in the order they were tapped
let moving = false;      // showing ⬇ slots to move the selection
const filter = { tags: new Set(), untagged: false };
const undoStack = [];

// When the last backup was made and how many changes since, for reminders.
const backupStatus = { at: 0, changes: 0, snoozeUntil: 0, ...JSON.parse(localStorage.getItem('backup') || '{}') };
const thumbUrls = new Map();
const tiles = new Map();

// ---------- State helpers ----------

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const fileKey = f => `${f.name}|${f.size}|${f.lastModified}`;
const byImport = (a, b) => photos.get(a).order - photos.get(b).order;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const tagById = id => state.tags.find(t => t.id === id);
const tagIdsOf = id => state.photoTags[id] || [];
const tagsOf = id => tagIdsOf(id).map(tagById).filter(Boolean);
const findTag = name => state.tags.find(t => t.name.toLowerCase() === name.trim().toLowerCase());

function tagCounts() {
  const counts = new Map();
  for (const id of state.order) for (const t of tagIdsOf(id)) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

function visibleIds() {
  const shown = state.order.filter(id => {
    const tags = tagIdsOf(id);
    if (filter.untagged) return tags.length === 0;
    for (const t of filter.tags) if (!tags.includes(t)) return false;
    return true;
  });
  return displayOrder(shown, tagsOf);
}

// Make the state consistent with the photos we actually have.
function normalize() {
  const seen = new Set();
  const keep = id => photos.has(id) && !seen.has(id) && seen.add(id);
  state.removed = state.removed.filter(keep);
  state.order = state.order.filter(keep);
  state.order.push(...[...photos.keys()].filter(id => !seen.has(id)).sort(byImport));
  const known = new Set(state.tags.map(t => t.id));
  for (const [id, list] of Object.entries(state.photoTags)) {
    const clean = [...new Set(list)].filter(t => known.has(t));
    if (!photos.has(id) || !clean.length) delete state.photoTags[id];
    else state.photoTags[id] = clean;
  }
  for (const t of [...filter.tags]) if (!known.has(t)) filter.tags.delete(t);
  for (const p of photos.values()) state.nextOrder = Math.max(state.nextOrder, p.order + 1);
}

// The first version of the app used groups. Each group becomes a tag.
function migrate(saved) {
  if (!saved.groups) return { ...emptyState(), ...saved };
  const s = { ...emptyState(), removed: saved.removed || [], nextOrder: saved.nextOrder || 0 };
  for (const g of saved.groups) {
    let tag = s.tags.find(t => t.name.toLowerCase() === g.name.toLowerCase());
    if (!tag) s.tags.push(tag = { id: g.id, name: g.name });
    for (const id of g.photoIds) {
      s.order.push(id);
      s.photoTags[id] = [tag.id];
    }
  }
  s.order.push(...(saved.unsorted || []));
  return s;
}

// Every user edit goes through here so it can be undone.
function change(fn) {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 60) undoStack.shift();
  const result = fn();
  normalize();
  persist();
  render();
  return result;
}

function undo() {
  if (!undoStack.length) return;
  state = JSON.parse(undoStack.pop());
  normalize();
  selection = selection.filter(id => state.order.includes(id));
  persist();
  render();
}

// Saved straight away on every change, so a crash can't lose more than the
// change being made. IndexedDB copies `state` when the save starts, and runs
// saves in the order they were made.
let saveError = null;
let active = true; // false once another window has taken over
function persist() {
  if (!active) return;
  backupStatus.changes++;
  localStorage.setItem('backup', JSON.stringify(backupStatus));
  db.saveState(state).then(() => {
    if (saveError) {
      saveError = null;
      renderNotice();
    }
  }, err => {
    console.error('Saving failed', err);
    saveError = err;
    renderNotice();
  });
}

// ---------- Tag edits ----------

// Call inside change().
function createTag(name) {
  const tag = { id: newId(), name: name.trim() };
  state.tags.push(tag);
  return tag;
}

function addTag(tagId, ids) {
  for (const id of ids) {
    const list = tagIdsOf(id);
    if (!list.includes(tagId)) state.photoTags[id] = [...list, tagId];
  }
}

function removeTag(tagId, ids) {
  for (const id of ids) state.photoTags[id] = tagIdsOf(id).filter(t => t !== tagId);
}

// Tapping a tag: if every photo has it, take it off; otherwise add it to all.
function toggleTag(tag, ids) {
  const all = ids.every(id => tagIdsOf(id).includes(tag.id));
  change(() => (all ? removeTag : addTag)(tag.id, ids));
}

function addTagByName(name, ids) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return;
  change(() => addTag((findTag(name) || createTag(name)).id, ids));
}

// ---------- Tag chips ----------

function chip(label, { count = null, on = false, some = false, year = false, extra = '' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (on ? ' on' : '') + (some ? ' some' : '') + (year ? ' year' : '') + (extra ? ' ' + extra : '');
  b.textContent = (on ? '✓ ' : '') + label;
  if (count !== null) {
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = count;
    b.append(n);
  }
  return b;
}

// Chips for choosing tags for `ids`, narrowed by what's typed in `query`.
function renderTagPicker(container, ids, query) {
  const q = query.trim().toLowerCase();
  const chips = [];
  for (const tag of sortTags(state.tags)) {
    if (q && !tag.name.toLowerCase().includes(q)) continue;
    const have = ids.filter(id => tagIdsOf(id).includes(tag.id)).length;
    const c = chip(tag.name, { on: ids.length > 0 && have === ids.length, some: have > 0 && have < ids.length, year: yearOf(tag.name) !== null });
    c.addEventListener('click', () => toggleTag(tag, ids));
    chips.push(c);
  }
  if (q && !findTag(q)) {
    const c = chip(`＋ New tag “${query.trim()}”`, { extra: 'create' });
    c.addEventListener('click', () => addTagByName(query, ids));
    chips.unshift(c);
  }
  if (!chips.length) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = state.tags.length ? 'No tags match.' : 'No tags yet. Type one above, e.g. “1980” or “Christmas”.';
    chips.push(hint);
  }
  container.replaceChildren(...chips);
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
  el.innerHTML = '<img loading="lazy" decoding="async" alt=""><span class="badge"></span>' +
    '<span class="caption"></span><button class="zoom" aria-label="View larger">⤢</button>';
  el.querySelector('img').src = thumbUrl(p);
  tiles.set(id, el);
  return el;
}

function updateTile(el) {
  const id = el.dataset.id;
  const n = selection.indexOf(id);
  el.classList.toggle('selected', n >= 0);
  el.querySelector('.badge').textContent = n >= 0 ? n + 1 : '';
  el.querySelector('.caption').textContent = sortTags(tagsOf(id)).map(t => t.name).join(', ');
}

function slot(index) {
  const b = document.createElement('button');
  b.className = 'slot';
  b.dataset.index = index;
  b.textContent = '⬇';
  b.setAttribute('aria-label', 'Move the selected photos here');
  return b;
}

function empty(text) {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  return d;
}

function render() {
  $('tab-photos').classList.toggle('active', view === 'photos');
  $('tab-tagger').classList.toggle('active', view === 'tagger');
  $('view-photos').hidden = view !== 'photos';
  $('view-tagger').hidden = view !== 'tagger';
  $('btn-undo').disabled = undoStack.length === 0;

  if (view === 'photos') renderPhotos();
  else renderTagger();

  const selecting = view === 'photos' && selection.length > 0;
  $('action-bar').hidden = !selecting;
  if (selecting) {
    $('selected-count').textContent = `${plural(selection.length, 'photo')} selected`;
    $('action-hint').textContent = moving ? 'Tap a ⬇ where they should go' : '';
    for (const id of ['btn-tag-selected', 'btn-tag-one-by-one', 'btn-move', 'btn-remove']) $(id).hidden = moving;
  }
  if ($('tag-sheet').open) renderSheet();
  if (!$('viewer').hidden) updateViewer();
  renderNotice();
  saveUi();
}

// Where he was (tab, tagger position, filter), so reopening the app carries
// on from the same place.
function saveUi() {
  if (!active) return;
  localStorage.setItem('ui', JSON.stringify({
    view,
    filterTags: [...filter.tags],
    filterUntagged: filter.untagged,
    tagger: { mode: tagger.mode, ids: tagger.ids, current: taggerId() || null, lastTags: tagger.lastTags },
  }));
}

function restoreUi() {
  let ui;
  try {
    ui = JSON.parse(localStorage.getItem('ui'));
  } catch {
    return;
  }
  if (!ui) return;
  view = ui.view === 'tagger' ? 'tagger' : 'photos';
  ui.filterTags?.forEach(t => filter.tags.add(t));
  filter.untagged = !!ui.filterUntagged;
  normalize(); // drops filter tags that no longer exist
  if (ui.tagger?.ids) {
    const live = new Set(state.order);
    tagger.mode = ui.tagger.mode;
    tagger.ids = ui.tagger.ids.filter(id => live.has(id));
    tagger.lastTags = ui.tagger.lastTags || [];
    const at = tagger.ids.indexOf(ui.tagger.current);
    tagger.index = at >= 0 ? at : ui.tagger.current ? 0 : tagger.ids.length;
  }
}

// ---------- Notices: save problems, storage protection, backup reminders ----------

let storageProtected = true;

function renderNotice() {
  const box = $('notice');
  const buttons = [];
  let text = '';
  let kind = 'info';
  const days = ms => ms / 86_400_000;

  if (!active) {
    box.hidden = true;
    return;
  }
  if (saveError) {
    kind = 'error';
    text = `⚠ Your last change couldn’t be saved (${saveError.message || saveError}). ` +
      (saveError.name === 'QuotaExceededError' ? 'The tablet may be out of space.' : '');
    buttons.push(['Try again', () => persist()]);
  } else if (!storageProtected && photos.size && Date.now() > (Number(localStorage.getItem('storageNoteSnooze')) || 0)) {
    text = 'Your work is saved on this tablet, but Chrome might clear it if the tablet runs low on space. ' +
      'To protect it, install the app (Chrome menu ⋮ → “Add to Home screen”) and open it from its icon. Saving a backup also keeps it safe.';
    buttons.push(['Back up now', backupEverything]);
    buttons.push(['Not now', () => {
      localStorage.setItem('storageNoteSnooze', Date.now() + 7 * 86_400_000);
      renderNotice();
    }]);
  } else if (photos.size && Date.now() > backupStatus.snoozeUntil && (
    (!backupStatus.at && backupStatus.changes >= 30) ||
    (backupStatus.at && (backupStatus.changes >= 150 || (backupStatus.changes > 0 && days(Date.now() - backupStatus.at) >= 14)))
  )) {
    text = backupStatus.at
      ? `Your last backup was ${Math.round(days(Date.now() - backupStatus.at))} days ago. It’s a good idea to save a new one.`
      : 'Tip: save a backup of your photos and tags, so nothing is lost if anything happens to the tablet.';
    buttons.push(['Back up now', backupEverything]);
    buttons.push(['Later', () => {
      backupStatus.snoozeUntil = Date.now() + 3 * 86_400_000;
      localStorage.setItem('backup', JSON.stringify(backupStatus));
      renderNotice();
    }]);
  }

  box.hidden = !text;
  box.className = 'notice ' + kind;
  $('notice-text').textContent = text;
  $('notice-buttons').replaceChildren(...buttons.map(([label, fn]) => {
    const b = document.createElement('button');
    b.className = 'btn btn-small';
    b.textContent = label;
    b.onclick = fn;
    return b;
  }));
}

// Asks Chrome not to clear the app's storage when space runs low. Chrome
// decides by itself; installed apps are normally allowed.
async function checkStorage() {
  if (!navigator.storage?.persisted) return;
  storageProtected = await navigator.storage.persisted() || await navigator.storage.persist();
  renderNotice();
}

function renderPhotos() {
  // Filter chips
  const counts = tagCounts();
  const untaggedCount = state.order.filter(id => !tagIdsOf(id).length).length;
  const chips = [];
  if (state.order.length) {
    const u = chip('Untagged', { count: untaggedCount, on: filter.untagged, extra: 'special' });
    u.addEventListener('click', () => {
      filter.untagged = !filter.untagged;
      filter.tags.clear();
      render();
    });
    chips.push(u);
  }
  for (const tag of sortTags(state.tags)) {
    const c = chip(tag.name, { count: counts.get(tag.id) || 0, on: filter.tags.has(tag.id), year: yearOf(tag.name) !== null });
    c.addEventListener('click', () => {
      filter.untagged = false;
      if (filter.tags.has(tag.id)) filter.tags.delete(tag.id);
      else filter.tags.add(tag.id);
      render();
    });
    chips.push(c);
  }
  $('filter-chips').replaceChildren(...chips);

  const ids = visibleIds();
  const filtering = filter.untagged || filter.tags.size > 0;
  const filterName = filter.untagged ? 'Untagged'
    : sortTags([...filter.tags].map(tagById).filter(Boolean)).map(t => t.name).join(' + ');
  $('filter-summary').textContent = filtering
    ? `${filterName}: ${plural(ids.length, 'photo')}`
    : `All photos: ${state.order.length}`;
  $('btn-show-all').hidden = !filtering;
  $('btn-select-all').hidden = !ids.length;
  $('btn-select-all').textContent = ids.length && ids.every(id => selection.includes(id)) ? 'Select none' : 'Select all';

  // Grid, with a heading wherever the year changes
  const body = $('photos-body');
  const scroll = body.scrollTop;
  if (ids.length) {
    const grid = document.createElement('div');
    grid.className = 'grid';
    let lastYear;
    ids.forEach((id, i) => {
      const years = tagsOf(id).map(t => yearOf(t.name)).filter(y => y !== null);
      const year = years.length ? String(Math.min(...years)) : 'No year yet';
      if (year !== lastYear) {
        const h = document.createElement('h3');
        h.className = 'year-heading';
        h.textContent = year;
        grid.append(h);
        lastYear = year;
      }
      if (moving) grid.append(slot(i));
      const t = tileFor(id);
      updateTile(t);
      grid.append(t);
    });
    if (moving) grid.append(slot(ids.length));
    body.replaceChildren(grid);
  } else {
    body.replaceChildren(empty(
      !photos.size ? 'Tap “＋ Add photos” to choose the scanned photos.'
        : filtering ? 'No photos match. Tap “Show all” to see everything.'
          : 'No photos.'));
  }
  body.scrollTop = scroll;
}

function applyTileSize() {
  const size = tileSize();
  document.documentElement.style.setProperty('--tile', size + 'px');
}

// ---------- Selection actions ----------

function toggleSelect(id) {
  const i = selection.indexOf(id);
  if (i >= 0) selection.splice(i, 1);
  else selection.push(id);
  render();
}

function clearSelection() {
  selection = [];
  moving = false;
  render();
}

// Puts the selection before the photo shown at `index` in the current view.
function placeSelection(index) {
  const shown = visibleIds();
  const chosen = new Set(selection);
  change(() => {
    const rest = state.order.filter(id => !chosen.has(id));
    const after = shown.slice(index).find(id => !chosen.has(id));
    const before = shown.slice(0, index).reverse().find(id => !chosen.has(id));
    const at = after ? rest.indexOf(after) : before ? rest.indexOf(before) + 1 : rest.length;
    rest.splice(at, 0, ...selection);
    state.order = rest;
    selection = [];
    moving = false;
  });
}

async function removeSelection(ids = selection) {
  const ok = await confirmIt(`Remove ${plural(ids.length, 'photo')}?`,
    'They will be left out of the export (useful for duplicates or bad scans). The original files on the tablet are not deleted.',
    'Remove', true);
  if (!ok) return false;
  const gone = [...ids];
  change(() => {
    state.order = state.order.filter(id => !gone.includes(id));
    state.removed.push(...gone);
    selection = selection.filter(id => !gone.includes(id));
  });
  return true;
}

// ---------- Tag sheet (tags for the selected photos) ----------

function openSheet() {
  $('tag-sheet-input').value = '';
  renderSheet();
  $('tag-sheet').showModal();
}

function renderSheet() {
  $('tag-sheet-title').textContent = `Tags for ${plural(selection.length, 'photo')}`;
  renderTagPicker($('tag-sheet-chips'), selection, $('tag-sheet-input').value);
}

function sheetAdd() {
  addTagByName($('tag-sheet-input').value, selection);
  $('tag-sheet-input').value = '';
  renderSheet();
}

// ---------- Tagger ----------

const tagger = { mode: 'untagged', ids: [], index: 0, lastTags: [], url: null, shownId: null };

function startTagger(mode, ids) {
  tagger.mode = mode;
  tagger.ids = ids || (mode === 'untagged'
    ? displayOrder(state.order.filter(id => !tagIdsOf(id).length), tagsOf)
    : displayOrder(state.order, tagsOf));
  tagger.index = 0;
}

const taggerId = () => tagger.ids[tagger.index];

function leaveTaggerPhoto() {
  const id = taggerId();
  if (id && tagIdsOf(id).length) tagger.lastTags = [...tagIdsOf(id)];
}

function taggerStep(delta) {
  leaveTaggerPhoto();
  tagger.index = Math.max(0, Math.min(tagger.ids.length, tagger.index + delta));
  $('tagger-input').value = '';
  render();
}

// Tags to offer with "Same as last photo": the previous photo's, or else
// the last photo that had any.
function copyableTags() {
  const prev = tagger.ids[tagger.index - 1];
  const ids = prev && tagIdsOf(prev).length ? tagIdsOf(prev) : tagger.lastTags;
  return ids.map(tagById).filter(Boolean);
}

function renderTagger() {
  // Drop photos removed since the list was made.
  const live = new Set(state.order);
  const current = taggerId();
  tagger.ids = tagger.ids.filter(id => live.has(id));
  const at = tagger.ids.indexOf(current);
  if (at >= 0) tagger.index = at;
  tagger.index = Math.min(tagger.index, tagger.ids.length);

  $('tagger-mode-untagged').classList.toggle('active', tagger.mode === 'untagged');
  $('tagger-mode-all').classList.toggle('active', tagger.mode === 'all');

  const id = taggerId();
  const img = $('tagger-img');
  const done = $('tagger-done');
  const finished = !id;
  for (const el of ['tagger-current', 'tagger-copy', 'tagger-chips', 'tagger-remove']) $(el).hidden = finished;
  document.querySelector('#view-tagger .tag-entry').hidden = finished;
  $('tagger-next').disabled = finished;
  $('tagger-back').disabled = tagger.index === 0;

  if (finished) {
    img.hidden = true;
    done.hidden = false;
    if (tagger.url) URL.revokeObjectURL(tagger.url);
    tagger.url = tagger.shownId = null;
    const untagged = state.order.filter(i => !tagIdsOf(i).length).length;
    done.replaceChildren();
    const msg = document.createElement('p');
    msg.textContent = !photos.size ? 'Add some photos first.'
      : tagger.ids.length ? 'That’s the last one!'
        : tagger.mode === 'untagged' ? 'Every photo has a tag.' : 'No photos to show.';
    done.append(msg);
    if (untagged && tagger.mode !== 'untagged') {
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.textContent = `Tag the ${plural(untagged, 'untagged photo')}`;
      b.onclick = () => { startTagger('untagged'); render(); };
      done.append(b);
    }
    if (photos.size) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = 'Go through all photos';
      b.onclick = () => { startTagger('all'); render(); };
      done.append(b);
    }
    $('tagger-progress').textContent = '';
    return;
  }

  img.hidden = false;
  done.hidden = true;
  if (tagger.shownId !== id) {
    if (tagger.url) URL.revokeObjectURL(tagger.url);
    tagger.url = URL.createObjectURL(photos.get(id).blob);
    tagger.shownId = id;
    img.src = tagger.url;
  }

  const label = tagger.mode === 'untagged' ? 'Untagged' : tagger.mode === 'selection' ? 'Selected' : 'Photo';
  $('tagger-progress').textContent = `${label} ${tagger.index + 1} of ${tagger.ids.length}`;

  const mine = sortTags(tagsOf(id));
  const cur = $('tagger-current');
  cur.replaceChildren();
  if (mine.length) {
    cur.append('This photo: ');
    const s = document.createElement('strong');
    s.textContent = mine.map(t => t.name).join(', ');
    cur.append(s);
  } else {
    cur.textContent = 'No tags on this photo yet.';
  }

  const copy = copyableTags();
  const missing = copy.filter(t => !tagIdsOf(id).includes(t.id));
  $('tagger-copy').hidden = copy.length === 0;
  $('tagger-copy').disabled = missing.length === 0;
  $('tagger-copy').textContent = missing.length
    ? `＋ Same as last photo: ${sortTags(copy).map(t => t.name).join(', ')}`
    : `✓ Has the last photo’s tags`;

  renderTagPicker($('tagger-chips'), [id], $('tagger-input').value);
}

function taggerAdd() {
  const id = taggerId();
  if (!id) return;
  addTagByName($('tagger-input').value, [id]);
  $('tagger-input').value = '';
  render();
}

function showTagger(ids) {
  if (ids) startTagger('selection', ids);
  else if (!tagger.ids.length || tagger.index >= tagger.ids.length) startTagger(tagger.mode === 'selection' ? 'untagged' : tagger.mode);
  selection = [];
  moving = false;
  view = 'tagger';
  render();
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
      if (dialog.open) dialog.close();
      resolve(value);
    };
    let primary = null;
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : '');
      btn.textContent = b.label;
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

// total = null shows a moving bar, for waits of unknown length.
function showProgress(text, done = 0, total = 1) {
  $('progress').hidden = false;
  $('progress-text').textContent = text;
  $('progress-bar').classList.toggle('indeterminate', total === null);
  $('progress-bar').style.width = total === null ? '' : `${total ? (100 * done) / total : 0}%`;
}
const hideProgress = () => { $('progress').hidden = true; };

// ---------- Tag management ----------

async function manageTags() {
  const counts = tagCounts();
  const rows = document.createElement('div');
  rows.className = 'tag-rows';
  let picked = null;
  for (const tag of sortTags(state.tags)) {
    const row = document.createElement('div');
    row.className = 'tag-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = tag.name;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = plural(counts.get(tag.id) || 0, 'photo');
    name.append(n);
    row.append(name);
    for (const [action, label] of [['rename', 'Rename'], ['delete', 'Delete']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-small' + (action === 'delete' ? ' btn-danger' : '');
      b.textContent = label;
      b.onclick = () => {
        picked = { action, tag };
        $('dialog').close();
      };
      row.append(b);
    }
    rows.append(row);
  }
  if (!state.tags.length) rows.append(empty('No tags yet.'));

  const res = await ask({
    title: 'Tags',
    message: rows,
    buttons: [{ label: '＋ New tag', value: 'new' }, { label: 'Close', value: 'close', primary: true }],
  });
  if (res === 'new') {
    const r = await ask({
      title: 'New tag',
      input: { placeholder: 'e.g. 1980, Christmas, Beach' },
      buttons: [{ label: 'Cancel' }, { label: 'Create', value: true, primary: true }],
    });
    if (r && !findTag(r.text)) change(() => createTag(r.text));
    return manageTags();
  }
  if (!picked) return;
  if (picked.action === 'rename') await renameTag(picked.tag);
  else await deleteTag(picked.tag);
  return manageTags();
}

async function renameTag(tag) {
  const r = await ask({
    title: `Rename “${tag.name}”`,
    message: 'Renaming to the name of another tag merges the two.',
    input: { value: tag.name },
    buttons: [{ label: 'Cancel' }, { label: 'Save', value: true, primary: true }],
  });
  if (!r || r.text === tag.name) return;
  const other = findTag(r.text);
  if (other && other.id !== tag.id) {
    const ok = await confirmIt(`Merge into “${other.name}”?`,
      `There's already a tag called “${other.name}”. Every photo tagged “${tag.name}” will be tagged “${other.name}” instead.`, 'Merge');
    if (!ok) return;
    change(() => {
      const ids = state.order.filter(id => tagIdsOf(id).includes(tag.id));
      addTag(other.id, ids);
      state.tags = state.tags.filter(t => t.id !== tag.id);
    });
  } else {
    change(() => { tagById(tag.id).name = r.text; });
  }
}

async function deleteTag(tag) {
  const n = tagCounts().get(tag.id) || 0;
  const ok = await confirmIt(`Delete “${tag.name}”?`,
    n ? `It will be taken off ${plural(n, 'photo')}. The photos stay.` : 'No photos have this tag.', 'Delete tag', true);
  if (ok) change(() => { state.tags = state.tags.filter(t => t.id !== tag.id); });
}

// ---------- Importing ----------

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif|tiff?|avif)$/i;
const isImage = f => f.type.startsWith('image/') || IMAGE_EXT.test(f.name);

async function makeThumb(file) {
  try {
    // Decode straight to thumbnail size when the JPEG header gives the size.
    // Skipped for rotated photos, where the size in the header is sideways.
    const info = await jpegInfo(file).catch(() => null);
    let bmp;
    if (info && info.width && info.height && info.orientation <= 1) {
      const scale = Math.min(1, THUMB_SIZE / Math.min(info.width, info.height));
      bmp = await createImageBitmap(file, {
        resizeWidth: Math.round(info.width * scale),
        resizeHeight: Math.round(info.height * scale),
        resizeQuality: 'medium',
      });
    } else {
      bmp = await createImageBitmap(file);
    }
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

// Photos processed at the same time. Chrome decodes and encodes images off
// the main thread, so this keeps several cores busy.
const IMPORT_PARALLEL = 3;

async function importFiles(files) {
  files = files.filter(isImage);
  if (!files.length) hideProgress();
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

  checkStorage();
  // Numbered up front so the order stays right even though photos finish
  // out of order. Each photo is stored as soon as it's ready; if the app is
  // closed part way, the stored ones are picked up again on the next start.
  const queue = fresh.map(f => ({ f, order: state.nextOrder++ }));
  const added = [];
  let done = 0;
  showProgress(`Adding photos… 0 of ${fresh.length}`, 0, fresh.length);
  try {
    let failed = null;
    const worker = async () => {
      while (queue.length && !failed) {
        const { f, order } = queue.shift();
        try {
          const photo = {
            id: newId(),
            name: f.name,
            size: f.size,
            lastModified: f.lastModified,
            type: f.type,
            order,
            blob: f,
            thumb: await makeThumb(f),
          };
          await db.putPhoto(photo);
          photos.set(photo.id, photo);
          added.push(photo.id);
        } catch (err) {
          failed = failed || err;
        }
        done++;
        showProgress(`Adding photos… ${done} of ${fresh.length}`, done, fresh.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMPORT_PARALLEL, fresh.length) }, worker));
    if (failed) throw failed;
  } catch (err) {
    console.error(err);
    await tell('Couldn’t add all the photos', `Something went wrong: ${err.message}. The photos added so far have been kept.`);
  } finally {
    hideProgress();
  }

  state.order.push(...added.sort(byImport));
  if (restored.length) {
    state.removed = state.removed.filter(id => !restored.includes(id));
    state.order.push(...restored);
  }
  normalize();
  persist();
  render();
  if (skipped) tell('Some photos were already here', `${skipped} of the chosen photos had already been added, so they were skipped.`);
}

// Android sends image-only pickers to its photo picker (often just Google
// Photos), so folders on the tablet are reached through the Files option.
async function addPhotos() {
  const choice = await ask({
    title: 'Add photos from…',
    stacked: true,
    buttons: [
      { label: 'Files and folders on this tablet', value: 'files', primary: true },
      ...(canPickFolder ? [{ label: 'A whole folder (adds every photo in it)', value: 'folder' }] : []),
      { label: 'Gallery / Google Photos', value: 'gallery' },
      { label: 'Cancel' },
    ],
  });
  if (choice === 'files') pickFiles();
  else if (choice === 'folder') importFolder();
  else if (choice === 'gallery') openFileInput('file-input');
}

// Prefer the system file browser where Chrome offers it: unlike the file
// input, it can't be redirected to a default app such as Google Photos.
async function pickFiles() {
  if ('showOpenFilePicker' in window) {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      let ready = 0;
      showProgress(`Getting your photos ready… 0 of ${handles.length}`, 0, handles.length);
      const files = await Promise.all(handles.map(async h => {
        const file = await h.getFile();
        ready++;
        showProgress(`Getting your photos ready… ${ready} of ${handles.length}`, ready, handles.length);
        return file;
      }));
      return importFiles(files);
    } catch (err) {
      hideProgress();
      if (err.name === 'AbortError') return;
      console.warn('File picker failed, using the file input instead', err);
    }
  }
  openFileInput('file-input-files');
}

// With the file input, Android can take a while to hand over the chosen
// files after the picker closes. Show that something is happening as soon
// as the app is back on screen.
let waitingForPick = false;
function openFileInput(id) {
  waitingForPick = true;
  $(id).click();
}
function pickerClosed() {
  if (!waitingForPick || document.hidden) return;
  showProgress('Getting your photos ready…', 0, null);
  // Normally replaced by the import's own progress, or cleared on cancel.
  setTimeout(() => {
    if (waitingForPick) {
      waitingForPick = false;
      hideProgress();
    }
  }, 60_000);
}

async function importFolder() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'import', mode: 'read' });
  } catch (err) {
    if (err.name !== 'AbortError') tell('Couldn’t open the folder', err.message);
    return;
  }
  const files = [];
  showProgress('Looking through the folder…', 0, null);
  try {
    for await (const handle of dir.values()) {
      if (handle.kind !== 'file') continue;
      files.push(await handle.getFile());
      showProgress(`Looking through the folder… found ${files.length}`, 0, null);
    }
  } catch (err) {
    hideProgress();
    return tell('Couldn’t read the folder', err.message);
  }
  await importFiles(files);
}

// ---------- Viewer ----------

const viewer = { ids: [], id: null, url: null, canSelect: false };

function openViewer(ids, id, canSelect) {
  Object.assign(viewer, { ids, id, canSelect });
  $('viewer').hidden = false;
  history.pushState({ viewer: true }, '');
  updateViewer();
}

function closeViewer() {
  if ($('viewer').hidden) return;
  $('viewer').hidden = true;
  $('viewer-img').removeAttribute('src');
  $('viewer-img').dataset.id = '';
  if (viewer.url) URL.revokeObjectURL(viewer.url);
  viewer.url = viewer.id = null;
}

function updateViewer() {
  viewer.ids = viewer.ids.filter(id => state.order.includes(id));
  const i = viewer.ids.indexOf(viewer.id);
  if (i < 0) return history.back();
  const img = $('viewer-img');
  if (img.dataset.id !== viewer.id) {
    if (viewer.url) URL.revokeObjectURL(viewer.url);
    viewer.url = URL.createObjectURL(photos.get(viewer.id).blob);
    img.src = viewer.url;
    img.dataset.id = viewer.id;
  }
  const tags = sortTags(tagsOf(viewer.id)).map(t => t.name).join(', ');
  $('viewer-label').textContent = `${i + 1} of ${viewer.ids.length}${tags ? ' · ' + tags : ''}`;
  $('viewer-prev').disabled = i === 0;
  $('viewer-next').disabled = i === viewer.ids.length - 1;
  $('viewer-select').hidden = !viewer.canSelect;
  const selected = selection.includes(viewer.id);
  $('viewer-select').textContent = selected ? '✓ Selected' : 'Select';
  $('viewer-select').classList.toggle('btn-primary', selected);
}

function stepViewer(delta) {
  const next = viewer.ids[viewer.ids.indexOf(viewer.id) + delta];
  if (next) {
    viewer.id = next;
    updateViewer();
  }
}

// ---------- Exporting ----------

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/gif': '.gif' };

function extensionOf(id) {
  const p = photos.get(id);
  const m = p.name.match(/\.[a-z0-9]{1,5}$/i);
  return m ? m[0].toLowerCase() : MIME_EXT[p.type] || '.jpg';
}

const isJpeg = p => p.type === 'image/jpeg' || /\.jpe?g$/i.test(p.name);

// The photo's bytes, with the date written in when it has a year tag.
async function exportBlob(item) {
  const p = photos.get(item.id);
  if (!item.date || !isJpeg(p)) return p.blob;
  try {
    return (await setJpegDate(p.blob, { date: item.date, tags: item.tags })) || p.blob;
  } catch (err) {
    console.warn('Could not set date on', p.name, err);
    return p.blob;
  }
}

async function exportPhotos() {
  clearSelection();
  if (!state.order.length) return tell('Nothing to export yet', 'Add some photos first.');
  const plan = planExport(state.order, tagsOf, extensionOf);
  const undated = plan.filter(p => !p.date).length;

  const message = document.createElement('div');
  const p1 = document.createElement('p');
  p1.textContent = `Each photo is saved once, named by year, number and tags, e.g. “${plan[0].name}”. ` +
    'Photos with a year tag also get that year as their date, so Google Photos puts them in the right place.';
  message.append(p1);
  if (undated) {
    const p2 = document.createElement('p');
    p2.textContent = `${plural(undated, 'photo')} ${undated === 1 ? 'has' : 'have'} no year tag. ` +
      'They come last, named “Undated…”, and keep their scan date.';
    message.append(p2);
  }
  if (canPickFolder) {
    const p3 = document.createElement('p');
    p3.textContent = 'Saving into a folder is easiest: make a new, empty folder (for example “Slides” inside Pictures) when asked.';
    message.append(p3);
  }

  const choice = await ask({
    title: `Export ${plural(plan.length, 'photo')}`,
    message,
    stacked: true,
    buttons: [
      ...(canPickFolder ? [{ label: 'Save into a folder', value: 'folder', primary: true }] : []),
      { label: 'Download as a ZIP file', value: 'zip', primary: !canPickFolder },
      { label: 'Cancel' },
    ],
  });
  if (choice === 'folder') await exportToFolder(plan);
  else if (choice === 'zip') await exportZip(plan);
}

const AFTER_EXPORT = 'Once you’re happy with them, delete the original scans, both on the tablet and in Google Photos ' +
  'if it backs up this tablet, so you don’t see every photo twice.';

async function exportToFolder(plan) {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'export', mode: 'readwrite', startIn: 'pictures' });
  } catch (err) {
    if (err.name !== 'AbortError') await offerZipInstead(plan, err);
    return;
  }

  let existing = 0;
  for await (const handle of dir.values()) if (handle.kind === 'file') existing++;
  if (existing) {
    const ok = await confirmIt('This folder isn’t empty',
      `“${dir.name}” already has ${plural(existing, 'file')} in it. Files with the same names will be replaced, ` +
      'and old files with different names would mix in with the new ones. It’s best to use a new, empty folder.',
      'Use it anyway');
    if (!ok) return;
  }

  try {
    for (let i = 0; i < plan.length; i++) {
      showProgress(`Saving photos… ${i + 1} of ${plan.length}`, i, plan.length);
      const file = await dir.getFileHandle(plan[i].name, { create: true });
      const out = await file.createWritable();
      await out.write(await exportBlob(plan[i]));
      await out.close();
    }
  } catch (err) {
    hideProgress();
    return offerZipInstead(plan, err);
  }
  hideProgress();
  await tell('Done!', `${plural(plan.length, 'photo')} saved into “${dir.name}”. Open the Gallery or Google Photos to check them. ${AFTER_EXPORT}`);
}

async function offerZipInstead(plan, err) {
  console.error(err);
  const ok = await confirmIt('Couldn’t save into that folder',
    `${err.message || err}. You can download the photos as a ZIP file instead.`, 'Download ZIP');
  if (ok) await exportZip(plan);
}

async function exportZip(plan) {
  let zip;
  try {
    const entries = plan.map(item => ({ name: item.name, date: item.date, blob: () => exportBlob(item) }));
    zip = await makeZip(entries, (done, total) => showProgress(`Preparing ZIP… ${done} of ${total}`, done, total));
  } catch (err) {
    hideProgress();
    return tell('Couldn’t make the ZIP', err.message);
  }
  hideProgress();
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Slides.zip';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  await tell('Download started',
    `When it finishes, open the Files app, tap “Slides.zip” and choose Extract. ${AFTER_EXPORT}`);
}

// ---------- Backup and restore ----------

// A backup is a ZIP holding every photo exactly as it was added, plus the
// tags and order, so the whole project can be rebuilt on any device.
async function backupEverything() {
  if (!photos.size) return tell('Nothing to back up yet', 'Add some photos first.');
  const ok = await confirmIt('Back up everything?',
    `This saves all ${plural(state.order.length, 'photo')} and their tags into one file in Downloads. ` +
    'Keep it somewhere safe, for example copy it to Google Drive or a computer. ' +
    'If anything ever goes wrong, “Restore from a backup” in the ⋯ menu brings everything back.',
    'Back up');
  if (!ok) return;

  const live = state.order.map(id => photos.get(id));
  const meta = {
    app: 'slide-sorter',
    format: 1,
    savedAt: new Date().toISOString(),
    state: { ...state, removed: [] },
    photos: live.map(({ id, name, size, lastModified, type, order }) => ({ id, name, size, lastModified, type, order })),
  };
  const entries = [{ name: 'backup.json', blob: new Blob([JSON.stringify(meta)], { type: 'application/json' }) }];
  for (const p of live) {
    entries.push({ name: `photos/${p.id}`, blob: p.blob, date: new Date(p.lastModified) });
    if (p.thumb) entries.push({ name: `thumbs/${p.id}`, blob: p.thumb });
  }

  let zip;
  try {
    zip = await makeZip(entries, (done, total) => showProgress(`Making backup… ${done} of ${total}`, done, total));
  } catch (err) {
    hideProgress();
    return tell('Couldn’t make the backup', err.message);
  }
  hideProgress();
  const stamp = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Slide Sorter backup ${stamp}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  Object.assign(backupStatus, { at: Date.now(), changes: 0, snoozeUntil: 0 });
  localStorage.setItem('backup', JSON.stringify(backupStatus));
  renderNotice();
  await tell('Backup saved', `“Slide Sorter backup ${stamp}.zip” is in Downloads. ` +
    'For extra safety, copy it to Google Drive or a computer.');
}

async function restoreBackup(file) {
  let files, meta;
  try {
    files = await readZip(file);
    meta = JSON.parse(await files.get('backup.json').text());
    if (meta.app !== 'slide-sorter') throw new Error();
  } catch {
    return tell('That isn’t a Slide Sorter backup', 'Choose a file called “Slide Sorter backup ….zip”.');
  }

  const when = new Date(meta.savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const ok = await confirmIt('Restore this backup?',
    `It's from ${when} and has ${plural(meta.photos.length, 'photo')}. ` +
    'Everything currently in Slide Sorter will be replaced by what’s in the backup.', 'Restore', true);
  if (!ok) return;

  try {
    // Photos first: if this is interrupted, the current work is still intact.
    for (let i = 0; i < meta.photos.length; i++) {
      showProgress(`Restoring photos… ${i + 1} of ${meta.photos.length}`, i, meta.photos.length);
      const m = meta.photos[i];
      const data = files.get(`photos/${m.id}`);
      if (!data) continue;
      const thumb = files.get(`thumbs/${m.id}`);
      await db.putPhoto({
        ...m,
        blob: new Blob([data], { type: m.type }),
        thumb: thumb ? new Blob([thumb], { type: 'image/jpeg' }) : await makeThumb(data),
      });
    }
    showProgress('Finishing…', 1, 1);
    const keep = new Set(meta.photos.map(p => p.id));
    await db.saveState(migrate(meta.state));
    await db.deletePhotos([...photos.keys()].filter(id => !keep.has(id)));
  } catch (err) {
    hideProgress();
    return tell('Restore didn’t finish', `${err.message}. Nothing was lost; you can try again.`);
  }
  hideProgress();
  // Start fresh from what's now stored.
  localStorage.removeItem('ui');
  location.reload();
}

// ---------- Menu ----------

async function storageSummary() {
  const mb = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
  let text = storageProtected ? 'Your work is saved on this tablet and protected.' : 'Your work is saved on this tablet.';
  try {
    const { usage, quota } = await navigator.storage.estimate();
    text += ` Using ${mb(usage)} of the ${mb(quota)} available.`;
    if (usage / quota > 0.8) text += ' Space is getting low: save a backup soon.';
  } catch {
    // estimate() unsupported: skip the numbers
  }
  return text;
}

async function showMenu() {
  const size = tileSize();
  const sizeName = TILE_NAMES[TILE_SIZES.indexOf(size)] || 'Medium';
  const last = backupStatus.at
    ? new Date(backupStatus.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : 'never';
  const choice = await ask({
    title: 'More options',
    message: await storageSummary(),
    stacked: true,
    buttons: [
      { label: `Back up everything (last backup: ${last})`, value: 'backup' },
      { label: 'Restore from a backup', value: 'restore' },
      ...(canPickFolder ? [{ label: 'Add every photo in a folder', value: 'folder' }] : []),
      { label: `Photo size: ${sizeName} (tap to change)`, value: 'size' },
      { label: 'How to use', value: 'help' },
      { label: 'Start over', value: 'reset', danger: true },
      { label: 'Close' },
    ],
  });
  if (choice === 'backup') backupEverything();
  else if (choice === 'restore') $('restore-input').click();
  else if (choice === 'folder') importFolder();
  else if (choice === 'size') {
    localStorage.setItem('tileSize', TILE_SIZES[(TILE_SIZES.indexOf(size) + 1) % TILE_SIZES.length]);
    applyTileSize();
  } else if (choice === 'help') showHelp();
  else if (choice === 'reset') startOver();
}

function showHelp() {
  const steps = document.createElement('ol');
  for (const text of [
    'Tap “＋ Add photos” and choose the scans. You can add more at any time.',
    'Open the Tagger to go through photos one at a time. Type or tap tags like “1980”, “Christmas”, “Beach”, then tap Next. “Same as last photo” copies the previous photo’s tags.',
    'A year tag (like 1980) puts the photo in that year. A month tag (like July) is optional.',
    'On the Photos screen, tap tags at the top to show only those photos.',
    'Tap photos to select them, then “Tags…” to tag them all at once, or “Move…” to change their order within a year.',
    'Tap ⤢ on a photo to see it bigger. Made a mistake? Tap “↶ Undo”.',
    'Your work is saved as you go, and the app opens where you left off. When finished, tap Export.',
    'Now and then, use ⋯ → “Back up everything” and keep the file somewhere safe, like Google Drive.',
  ]) {
    const li = document.createElement('li');
    li.textContent = text;
    steps.append(li);
  }
  tell('How to use', steps);
}

async function startOver() {
  const ok = await confirmIt('Start over?',
    'This clears all the photos and tags from Slide Sorter. The original files on the tablet are not deleted.',
    'Clear everything', true);
  if (!ok) return;
  await db.clearAll();
  thumbUrls.forEach(url => URL.revokeObjectURL(url));
  thumbUrls.clear();
  tiles.clear();
  photos.clear();
  state = emptyState();
  filter.tags.clear();
  filter.untagged = false;
  startTagger('untagged');
  selection = [];
  moving = false;
  undoStack.length = 0;
  render();
}

// ---------- Wiring ----------

function wire() {
  $('tab-photos').addEventListener('click', () => { leaveTaggerPhoto(); view = 'photos'; render(); });
  $('tab-tagger').addEventListener('click', () => showTagger());

  $('btn-add').addEventListener('click', addPhotos);
  for (const id of ['file-input', 'file-input-files']) {
    $(id).addEventListener('change', e => {
      waitingForPick = false;
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) importFiles(files);
      else hideProgress();
    });
    $(id).addEventListener('cancel', () => {
      waitingForPick = false;
      hideProgress();
    });
  }
  document.addEventListener('visibilitychange', pickerClosed);
  window.addEventListener('focus', pickerClosed);
  $('btn-tags').addEventListener('click', manageTags);
  $('btn-undo').addEventListener('click', undo);
  $('btn-export').addEventListener('click', exportPhotos);
  $('btn-menu').addEventListener('click', showMenu);
  $('taken-over-btn').addEventListener('click', () => location.reload());
  let scrollTimer = null;
  $('photos-body').addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => localStorage.setItem('scroll', $('photos-body').scrollTop), 300);
  }, { passive: true });
  $('restore-input').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) restoreBackup(file);
  });

  // Photos view
  $('btn-show-all').addEventListener('click', () => {
    filter.tags.clear();
    filter.untagged = false;
    render();
  });
  $('btn-select-all').addEventListener('click', () => {
    const ids = visibleIds();
    if (ids.every(id => selection.includes(id))) selection = selection.filter(id => !ids.includes(id));
    else selection.push(...ids.filter(id => !selection.includes(id)));
    render();
  });
  $('photos-body').addEventListener('click', e => {
    const zoom = e.target.closest('.zoom');
    if (zoom) return openViewer(visibleIds(), zoom.closest('.tile').dataset.id, true);
    const s = e.target.closest('.slot');
    if (s) return placeSelection(Number(s.dataset.index));
    const tile = e.target.closest('.tile');
    if (tile && !moving) toggleSelect(tile.dataset.id);
  });

  $('btn-tag-selected').addEventListener('click', openSheet);
  $('btn-tag-one-by-one').addEventListener('click', () => showTagger(displayOrder(selection, tagsOf)));
  $('btn-move').addEventListener('click', () => { moving = true; render(); });
  $('btn-remove').addEventListener('click', () => removeSelection());
  $('btn-clear').addEventListener('click', () => {
    if (moving) moving = false;
    else selection = [];
    render();
  });

  // Tag sheet
  $('tag-sheet-input').addEventListener('input', renderSheet);
  $('tag-sheet-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sheetAdd(); } });
  $('tag-sheet-add').addEventListener('click', sheetAdd);
  $('tag-sheet-done').addEventListener('click', () => $('tag-sheet').close());

  // Tagger
  $('tagger-next').addEventListener('click', () => taggerStep(1));
  $('tagger-back').addEventListener('click', () => taggerStep(-1));
  $('tagger-input').addEventListener('input', () => renderTagPicker($('tagger-chips'), [taggerId()], $('tagger-input').value));
  $('tagger-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); taggerAdd(); } });
  $('tagger-add').addEventListener('click', taggerAdd);
  $('tagger-copy').addEventListener('click', () => {
    const id = taggerId();
    const tags = copyableTags();
    if (id && tags.length) change(() => tags.forEach(t => addTag(t.id, [id])));
  });
  $('tagger-remove').addEventListener('click', () => removeSelection([taggerId()]));
  $('tagger-img').addEventListener('click', () => openViewer(tagger.ids, taggerId(), false));
  for (const mode of ['untagged', 'all']) {
    $(`tagger-mode-${mode}`).addEventListener('click', () => {
      leaveTaggerPhoto();
      startTagger(mode);
      render();
    });
  }

  // Viewer
  $('viewer-close').addEventListener('click', () => history.back());
  $('viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('viewer-next').addEventListener('click', () => stepViewer(1));
  $('viewer-select').addEventListener('click', () => toggleSelect(viewer.id));
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

}

// Only one window may edit at a time, or two copies of the app would save
// over each other. The newest window takes over; older ones stop saving.
async function claimWindow() {
  if (!navigator.locks) return;
  await new Promise(resolve => {
    navigator.locks.request('slide-sorter', { steal: true }, () => {
      resolve();
      return new Promise(() => {}); // held until this page closes
    }).catch(() => {
      active = false;
      for (const d of document.querySelectorAll('dialog[open]')) d.close();
      $('taken-over').hidden = false;
    });
  });
}

async function init() {
  applyTileSize();
  wire();
  await claimWindow();
  const [records, saved] = await Promise.all([db.getAllPhotos(), db.loadState()]);
  for (const r of records) photos.set(r.id, r);
  if (saved) state = migrate(saved);
  // Removed photos only need keeping for undo, which doesn't survive a
  // reload. Delete the photos before saving the state, so an interruption
  // can't bring them back.
  if (state.removed.length) {
    await db.deletePhotos(state.removed);
    state.removed.forEach(id => photos.delete(id));
    state.removed = [];
    await db.saveState(state);
  }
  normalize();
  startTagger('untagged');
  restoreUi();
  render();
  if (view === 'photos') $('photos-body').scrollTop = Number(localStorage.getItem('scroll')) || 0;
  checkStorage();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
