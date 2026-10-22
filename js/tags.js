// Tag helpers and export planning. Tags named like a year ("1980") or a
// month ("July", "Jul") have special meaning: they decide the photo's date
// and where it sorts.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

export function yearOf(name) {
  const m = /^\s*(\d{4})\s*$/.exec(name);
  const year = m && Number(m[1]);
  return year >= 1800 && year <= 2100 ? year : null;
}

// 0-11, or null. Accepts full names and abbreviations of 3+ letters.
export function monthOf(name) {
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  if (n.length < 3) return null;
  const i = MONTHS.findIndex(m => m.startsWith(n));
  return i >= 0 ? i : null;
}

const kindRank = name => (yearOf(name) !== null ? 0 : monthOf(name) !== null ? 1 : 2);

// Years first (oldest first), then months in calendar order, then the rest A-Z.
export function sortTags(tags) {
  return [...tags].sort((a, b) => kindRank(a.name) - kindRank(b.name)
    || (yearOf(a.name) ?? 0) - (yearOf(b.name) ?? 0)
    || (monthOf(a.name) ?? 0) - (monthOf(b.name) ?? 0)
    || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

// Where a photo belongs in time, from its tags. Several year tags (when he
// isn't sure) use the earliest.
function dating(tags) {
  const years = tags.map(t => yearOf(t.name)).filter(y => y !== null);
  const monthTag = tags.find(t => monthOf(t.name) !== null);
  return {
    year: years.length ? Math.min(...years) : null,
    month: monthTag ? monthOf(monthTag.name) : null,
    monthTag,
  };
}

const isDate = t => yearOf(t.name) !== null || monthOf(t.name) !== null;

// Least-used tags first (`counts` maps tag id -> photos with it), then A-Z.
// Tags on a single photo go last: they can't group anything, and listed
// first they would pull the photo away from the others it shares tags with.
function byUse(counts) {
  const uses = t => {
    const n = counts.get(t.id) || 0;
    return n < 2 ? Infinity : n;
  };
  return (a, b) => (uses(a) - uses(b) || 0)
    || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// A photo's non-date tags, least-used first. Specific tags (an event, a
// person) are used less than broad ones (Family, Beach), so sorting on this
// keeps the photos of each event together before the broad tags split them.
function groupKey(tags, counts) {
  return tags.filter(t => !isDate(t)).sort(byUse(counts));
}

export function countTags(ids, tagsOf) {
  const counts = new Map();
  for (const id of ids) for (const t of tagsOf(id)) counts.set(t.id, (counts.get(t.id) || 0) + 1);
  return counts;
}

function cleanPart(text) {
  return text.replace(/[\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '');
}

// The start of a photo's export filename, before the running number:
//   1980 - Beach, London
//   1980-07 - Beach
//   Undated - Beach
// Galleries that sort by name put photos with the same text together, so
// this text is what groups them. Tags are listed least-used first.
function namePrefix(tags, counts) {
  const { year, month } = dating(tags);
  const primaryYear = year !== null && tags.find(t => yearOf(t.name) === year);
  // Without a year the month can't go in the date, so it stays a label.
  // Any extra year tags (when he wasn't sure) go after the rest.
  const labels = [
    ...(year === null ? labelTags(tags, counts) : groupKey(tags, counts)),
    ...sortTags(tags).filter(t => yearOf(t.name) !== null && t !== primaryYear),
  ].map(t => cleanPart(t.name)).filter(Boolean);

  let label = labels.join(', ');
  if (label.length > 120) label = label.slice(0, 119).trim() + '…';
  const when = year === null ? 'Undated'
    : month === null ? String(year) : `${year}-${String(month + 1).padStart(2, '0')}`;
  return label ? `${when} - ${label}` : when;
}

// Compared the way a gallery sorts names, including the " - " before the
// number, so the app shows exactly the order the exported files will have.
const byFilename = (a, b) => {
  const x = (a + ' - ').toLowerCase();
  const y = (b + ' - ').toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

// The order photos are shown in and exported in: by filename (year, then
// month, then tags), then the order he arranged them in. `counts` should
// cover all photos, so a filtered view keeps the same order as the full one.
export function displayOrder(ids, tagsOf, counts = countTags(ids, tagsOf)) {
  const key = new Map(ids.map((id, i) => [id, { prefix: namePrefix(tagsOf(id), counts), i }]));
  return [...ids].sort((a, b) => {
    const ka = key.get(a);
    const kb = key.get(b);
    return byFilename(ka.prefix, kb.prefix) || ka.i - kb.i;
  });
}

// A photo's tags in the order its caption lists them: month, then the rest
// least-used first, matching its filename.
export function labelTags(tags, counts) {
  return [...tags.filter(t => monthOf(t.name) !== null), ...groupKey(tags, counts)];
}

// For each photo: its export filename, the date to write (null when it has
// no year tag) and its tags as text.
//   1980-07 - Beach, Family - 0042.jpg
// The tags come before the number, so sorting by name groups photos by their
// tags; the number then keeps his order within each group.
export function planExport(ids, tagsOf, extensionOf) {
  const counts = countTags(ids, tagsOf);
  const ordered = displayOrder(ids, tagsOf, counts);
  const pad = Math.max(4, String(ordered.length).length);
  const minutes = new Map(); // photos dated so far per year/month
  return ordered.map((id, i) => {
    const tags = sortTags(tagsOf(id));
    const { year, month } = dating(tags);
    const name = `${namePrefix(tags, counts)} - ${String(i + 1).padStart(pad, '0')}${extensionOf(id)}`;

    let date = null;
    if (year !== null) {
      // The 1st of the month (January if no month tag), one minute apart in
      // this order, so date-sorted apps show the same order as the filenames.
      const bucket = `${year}-${month ?? 0}`;
      const n = minutes.get(bucket) || 0;
      minutes.set(bucket, n + 1);
      date = new Date(year, month ?? 0, 1, 9, n, 0);
    }
    return { id, name, date, tags: tags.map(t => t.name) };
  });
}
