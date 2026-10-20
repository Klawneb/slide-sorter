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

// The order photos are shown in and exported in: by year (undated last),
// then month, then the order he arranged them in.
export function displayOrder(ids, tagsOf) {
  const key = new Map(ids.map((id, i) => [id, { ...dating(tagsOf(id)), i }]));
  return [...ids].sort((a, b) => {
    const ka = key.get(a);
    const kb = key.get(b);
    return (ka.year ?? Infinity) - (kb.year ?? Infinity)
      || (ka.month ?? 0) - (kb.month ?? 0)
      || ka.i - kb.i;
  });
}

function cleanPart(text) {
  return text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '');
}

// For each photo: its export filename, the date to write (null when it has
// no year tag) and its tags as text.
//   1980 - 0042 - July, Beach, Family.jpg
// The number comes before the other tags so that sorting by name keeps his
// order; sorting on the tag text would shuffle photos within a year.
export function planExport(ids, tagsOf, extensionOf) {
  const ordered = displayOrder(ids, tagsOf);
  const pad = Math.max(4, String(ordered.length).length);
  const minutes = new Map(); // photos dated so far per year/month
  return ordered.map((id, i) => {
    const tags = sortTags(tagsOf(id));
    const { year, month, monthTag } = dating(tags);
    const primaryYear = year !== null && tags.find(t => yearOf(t.name) === year);
    const labels = [
      ...(monthTag ? [monthTag] : []),
      ...tags.filter(t => t !== primaryYear && t !== monthTag),
    ].map(t => cleanPart(t.name)).filter(Boolean);

    let label = labels.join(', ');
    if (label.length > 120) label = label.slice(0, 119).trim() + '…';
    const name = `${year ?? 'Undated'} - ${String(i + 1).padStart(pad, '0')}${label ? ' - ' + label : ''}${extensionOf(id)}`;

    let date = null;
    if (year !== null) {
      // The 1st of the month (January if no month tag), one minute apart in
      // his order, so date-sorted apps show the same order as the filenames.
      const bucket = `${year}-${month ?? 0}`;
      const n = minutes.get(bucket) || 0;
      minutes.set(bucket, n + 1);
      date = new Date(year, month ?? 0, 1, 9, n, 0);
    }
    return { id, name, date, tags: tags.map(t => t.name) };
  });
}
