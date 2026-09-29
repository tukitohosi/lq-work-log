const COLLECTIONS = [
  ['workers', (item) => item.id],
  ['attendance', (item) => `${item.workerId}\u0000${item.date}`],
  ['monthlyRecords', (item) => `${item.workerId}\u0000${item.month}`],
  ['payAdjustments', (item) => item.id],
  ['sites', (item) => item.id],
];

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildAppDataDelta(before, after) {
  const upserts = {};
  const deletes = {};
  for (const [name, keyOf] of COLLECTIONS) {
    const previous = new Map(before[name].map((item) => [keyOf(item), item]));
    const latest = new Map(after[name].map((item) => [keyOf(item), item]));
    upserts[name] = [];
    deletes[name] = [];
    for (const [key, item] of latest) {
      if (!previous.has(key) || !equal(previous.get(key), item)) upserts[name].push(item);
    }
    for (const key of previous.keys()) {
      if (!latest.has(key)) deletes[name].push(key);
    }
  }
  return {
    kind: 'app-data-delta',
    schemaVersion: after.schemaVersion,
    revision: after.revision,
    upserts,
    deletes,
    ...(equal(before.settings, after.settings) ? {} : { settings: after.settings }),
  };
}

/**
 * Builds the same wire format while examining only entity keys that a trusted
 * mutation handler says it may have changed. This keeps a one-cell response
 * proportional to the affected collections instead of JSON-stringifying every
 * entity in a multi-year ledger.
 */
export function buildAppDataDeltaForKeys(before, after, selectedKeys = {}) {
  const upserts = {};
  const deletes = {};
  for (const [name, keyOf] of COLLECTIONS) {
    const selected = new Set(selectedKeys[name] ?? []);
    upserts[name] = [];
    deletes[name] = [];
    if (selected.size === 0) continue;

    const previous = selectedEntities(before[name], keyOf, selected);
    const latest = selectedEntities(after[name], keyOf, selected);
    for (const key of selected) {
      const hadPrevious = previous.has(key);
      const hasLatest = latest.has(key);
      if (hasLatest && (!hadPrevious || !equal(previous.get(key), latest.get(key)))) {
        upserts[name].push(latest.get(key));
      } else if (hadPrevious && !hasLatest) {
        deletes[name].push(key);
      }
    }
  }
  return {
    kind: 'app-data-delta',
    schemaVersion: after.schemaVersion,
    revision: after.revision,
    upserts,
    deletes,
    ...(selectedKeys.settings === true && !equal(before.settings, after.settings)
      ? { settings: after.settings }
      : {}),
  };
}

/**
 * Takes an owned snapshot of only the entities a trusted mutation can affect.
 * The clone is intentionally small: callers may retain it while the queued
 * write proceeds without keeping references to mutable store state.
 */
export function snapshotAppDataForKeys(data, selectedKeys = {}) {
  const snapshot = {
    schemaVersion: data.schemaVersion,
    revision: data.revision,
    workers: [],
    attendance: [],
    monthlyRecords: [],
    payAdjustments: [],
    sites: [],
    settings: selectedKeys.settings === true ? structuredClone(data.settings) : data.settings,
  };
  for (const [name, keyOf] of COLLECTIONS) {
    const selected = new Set(selectedKeys[name] ?? []);
    if (selected.size === 0) continue;
    let remaining = selected.size;
    for (const item of data[name]) {
      if (!selected.has(keyOf(item))) continue;
      snapshot[name].push(structuredClone(item));
      remaining -= 1;
      if (remaining === 0) break;
    }
  }
  return snapshot;
}

function selectedEntities(items, keyOf, selected) {
  const entities = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (selected.has(key)) entities.set(key, item);
  }
  return entities;
}

export function isAppDataDelta(value) {
  return value !== null && typeof value === 'object' && value.kind === 'app-data-delta';
}

export function applyAppDataDelta(base, delta) {
  if (!isAppDataDelta(delta)) throw new TypeError('mutation response is not an app-data delta');
  const next = structuredClone(base);
  next.schemaVersion = delta.schemaVersion;
  next.revision = delta.revision;
  for (const [name, keyOf] of COLLECTIONS) {
    const deleted = new Set(delta.deletes?.[name] ?? []);
    const changed = new Map((delta.upserts?.[name] ?? []).map((item) => [keyOf(item), item]));
    next[name] = next[name]
      .filter((item) => !deleted.has(keyOf(item)))
      .map((item) => changed.has(keyOf(item)) ? structuredClone(changed.get(keyOf(item))) : item);
    const existing = new Set(next[name].map((item) => keyOf(item)));
    for (const [key, item] of changed) {
      if (!existing.has(key)) next[name].push(structuredClone(item));
    }
  }
  if (delta.settings) next.settings = structuredClone(delta.settings);
  return next;
}
