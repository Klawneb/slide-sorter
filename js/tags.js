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

// Most-used tags first (`counts` maps tag id -> photos with it), then A-Z.
function byUse(counts) {
  return (a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)
    || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// A photo's non-date tags, most-used first. Sorting on this keeps photos
// with the same tags together, and a rarely used tag can't pull a photo away
// from the group of its common ones.
function groupKey(tags, counts) {
  return tags.filter(t => !isDate(t)).sort(byUse(counts));
}

export function countTags(ids, tagsOf) {
  const counts = new Map();
  for (const id of ids) for (const t of tagsOf(id)) counts.set(t.id, (counts.get(t.id) || 0) + 1);
  return counts;
}

// The order photos are shown in and exported in: by year (undated last),
// then month, then grouped by their other tags, then the order he arranged
// them in. `counts` should cover all photos, so a filtered view keeps the
// same order as the full one.
export function displayOrder(ids, tagsOf, counts = countTags(ids, tagsOf)) {
  const cmp = byUse(counts);
  const key = new Map(ids.map((id, i) => {
    const tags = tagsOf(id);
    return [id, { ...dating(tags), group: groupKey(tags, counts), i }];
  }));
  const compareGroups = (ga, gb) => {
    for (let j = 0; j < Math.min(ga.length, gb.length); j++) {
      const c = cmp(ga[j], gb[j]);
      if (c) return c;
    }
    // Untagged photos after the rest; otherwise fewer tags first.
    if (!ga.length || !gb.length) return gb.length - ga.length;
    return ga.length - gb.length;
  };
  return [...ids].sort((a, b) => {
    const ka = key.get(a);
    const kb = key.get(b);
    return (ka.year ?? Infinity) - (kb.year ?? Infinity)
      || (ka.month ?? 0) - (kb.month ?? 0)
      || compareGroups(ka.group, kb.group)
      || ka.i - kb.i;
  });
}

// A photo's tags in the order its filename and caption list them: month,
// then the rest most-used first, matching how the photos are grouped.
export function labelTags(tags, counts) {
  return [...tags.filter(t => monthOf(t.name) !== null), ...groupKey(tags, counts)];
}

function cleanPart(text) {
  return text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '');
}

// For each photo: its export filename, the date to write (null when it has
// no year tag) and its tags as text.
//   1980 - 0042 - July, Beach, Family.jpg
// The number comes before the other tags so that sorting by name keeps the
// display order; sorting on the tag text would shuffle photos within a year.
export function planExport(ids, tagsOf, extensionOf) {
  const counts = countTags(ids, tagsOf);
  const ordered = displayOrder(ids, tagsOf, counts);
  const pad = Math.max(4, String(ordered.length).length);
  const minutes = new Map(); // photos dated so far per year/month
  return ordered.map((id, i) => {
    const tags = sortTags(tagsOf(id));
    const { year, month } = dating(tags);
    const primaryYear = year !== null && tags.find(t => yearOf(t.name) === year);
    // Any extra year tags (when he wasn't sure) go after the rest.
    const labels = [
      ...labelTags(tags, counts),
      ...tags.filter(t => yearOf(t.name) !== null && t !== primaryYear),
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
