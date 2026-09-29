import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DataStore, MAX_DATA_BYTES, fingerprintDataDir } from './store.mjs';
import { resolveEffectiveDailyRate } from './payroll-rules.mjs';
import {
  buildAppDataDelta,
  buildAppDataDeltaForKeys,
  snapshotAppDataForKeys,
} from '../shared/app-data-delta.mjs';
import {
  ApiError,
  assertId,
  assertOvertimeStatus,
  assertAllowedKeys,
  assertIsoDate,
  assertIsoMonth,
  assertNullableTimestamp,
  assertOvertimePayPercent,
  assertPayAdjustmentKind,
  assertPlainObject,
  assertPositiveAmountFen,
  assertRateFen,
  assertStatus,
  assertTheme,
  assertTimestamp,
  assertWeekStartsOn,
  normalizeAvatarDataUrl,
  normalizeAvatarEmoji,
  normalizeDayNote,
  normalizeLabel,
  normalizeLeave,
  normalizeName,
  normalizeNote,
  validateAppData,
} from './validation.mjs';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SERVER_DIR, '..');
export const MAX_JSON_BYTES = MAX_DATA_BYTES + 64 * 1024;
const MAX_ATTENDANCE_PATCHES = 500;
const MAX_HISTORY_REVERT_TARGETS = 100;
const PERIODS = new Set(['morning', 'afternoon', 'overtime']);
const ATTENDANCE_PATCH_FIELDS = [
  'morning',
  'afternoon',
  'overtime',
  'dayNote',
  'morningSiteId',
  'afternoonSiteId',
  'overtimeSiteId',
  'morningLeave',
  'afternoonLeave',
  'overtimeLeave',
];
const ATTENDANCE_HISTORY_FIELDS = [...ATTENDANCE_PATCH_FIELDS];
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function applySecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function sendEmpty(response, status, extraHeaders = {}) {
  response.writeHead(status, { 'Content-Length': '0', ...extraHeaders });
  response.end();
}

function hostInfo(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0 || hostHeader.length > 255) {
    return null;
  }
  try {
    const url = new URL(`http://${hostHeader}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
      return null;
    }
    return { host: url.host.toLowerCase(), hostname };
  } catch {
    return null;
  }
}

function isLoopbackAddress(address) {
  if (!address) {
    return false;
  }
  const normalized = address.toLowerCase().split('%')[0];
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1'
  );
}

function assertLocalRequest(request) {
  const host = hostInfo(request.headers.host);
  if (!host || !isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, 'LOCAL_ONLY', '记工本只接受来自本机回环地址的请求');
  }
  return host;
}

function assertApiSession(request, expectedToken) {
  if (!expectedToken) return;
  const authorization = request.headers.authorization;
  const prefix = 'Bearer ';
  const received = typeof authorization === 'string' && authorization.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : '';
  const expectedBytes = Buffer.from(expectedToken, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  if (
    receivedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(receivedBytes, expectedBytes)
  ) {
    throw new ApiError(401, 'API_SESSION_REQUIRED', '桌面会话验证失败，请重新打开记工本');
  }
}

function assertSameOriginMutation(request, host, { bodyRequired = true } = {}) {
  const contentType = request.headers['content-type'];
  if (
    (bodyRequired || contentType !== undefined) &&
    (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType))
  ) {
    throw new ApiError(415, 'JSON_REQUIRED', '写入接口只接受 application/json');
  }
  const contentEncoding = request.headers['content-encoding'];
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    throw new ApiError(415, 'UNSUPPORTED_ENCODING', '不支持压缩的请求内容');
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new ApiError(403, 'ORIGIN_REJECTED', '请求来源无效');
    }
    if (originUrl.protocol !== 'http:' || originUrl.host.toLowerCase() !== host.host) {
      throw new ApiError(403, 'ORIGIN_REJECTED', '只允许同源页面写入数据');
    }
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new ApiError(403, 'ORIGIN_REJECTED', '只允许同源页面写入数据');
  }
}

async function readJson(request) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    request.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容超过了 64 MiB 数据恢复上限');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) {
      throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容超过了 64 MiB 数据恢复上限');
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    throw new ApiError(400, 'INVALID_JSON', '请求内容不能为空');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求内容不是有效 JSON');
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mutationOperation(request, method, pathname, body) {
  const raw = request.headers['x-lq-operation-id'];
  if (raw === undefined) return null;
  if (
    typeof raw !== 'string' || raw.length < 1 || raw.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(raw)
  ) {
    throw new ApiError(400, 'INVALID_OPERATION_ID', 'X-LQ-Operation-Id 格式无效');
  }
  const requestHash = createHash('sha256')
    .update(`${method}\n${pathname}\n${canonicalJson(body)}`)
    .digest('hex');
  return { operationId: raw, requestHash };
}

function attendanceDeltaKeys(pathname, body) {
  let patches;
  if (pathname === '/api/attendance') {
    patches = [body];
  } else if (pathname === '/api/attendance/day-note') {
    patches = [body];
  } else if (pathname === '/api/attendance/batch' || pathname === '/api/attendance/leave') {
    patches = Array.isArray(body?.patches) ? body.patches : [];
  } else {
    return null;
  }
  const attendance = new Set();
  const monthlyRecords = new Set();
  for (const patch of patches) {
    if (typeof patch?.workerId !== 'string' || typeof patch?.date !== 'string') continue;
    attendance.add(`${patch.workerId}\0${patch.date}`);
    monthlyRecords.add(`${patch.workerId}\0${patch.date.slice(0, 7)}`);
  }
  return {
    attendance: [...attendance],
    monthlyRecords: [...monthlyRecords],
  };
}

function findWorker(data, workerId, { allowArchived = false } = {}) {
  assertId(workerId, 'workerId');
  const worker = data.workers.find((candidate) => candidate.id === workerId);
  if (!worker) {
    throw new ApiError(404, 'WORKER_NOT_FOUND', '没有找到该工人');
  }
  if (!allowArchived && worker.archivedAt !== null) {
    throw new ApiError(409, 'WORKER_ARCHIVED', '已归档工人不能继续记工，请先恢复');
  }
  return worker;
}

function ensureMonthlyRecord(data, worker, month) {
  let monthly = data.monthlyRecords.find(
    (record) => record.workerId === worker.id && record.month === month,
  );
  if (!monthly) {
    monthly = {
      workerId: worker.id,
      month,
      dailyRateFen: resolveEffectiveDailyRate(data, worker, month).rateFen,
      overtimePayPercent: data.settings.defaultOvertimePayPercent,
      note: '',
      paidAt: null,
    };
    data.monthlyRecords.push(monthly);
  }
  return monthly;
}

function findSite(data, siteId, { allowArchived = false } = {}) {
  assertId(siteId, '工地 ID');
  const site = data.sites.find((candidate) => candidate.id === siteId);
  if (!site) {
    throw new ApiError(404, 'SITE_NOT_FOUND', '没有找到该工地');
  }
  if (!allowArchived && site.archivedAt !== null) {
    throw new ApiError(409, 'SITE_ARCHIVED', '已归档工地不能用于新记录，请先恢复');
  }
  return site;
}

function findPayAdjustment(data, adjustmentId) {
  assertId(adjustmentId, '补贴扣款 ID');
  const adjustment = data.payAdjustments.find((candidate) => candidate.id === adjustmentId);
  if (!adjustment) {
    throw new ApiError(404, 'PAY_ADJUSTMENT_NOT_FOUND', '没有找到该补贴扣款记录');
  }
  return adjustment;
}

async function addWorker(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, [
    'name', 'avatarDataUrl', 'avatarEmoji', 'defaultDailyRateFen', 'note', 'defaultSiteId',
  ]);
  const name = normalizeName(input.name);
  const avatarDataUrl = normalizeAvatarDataUrl(input.avatarDataUrl ?? null);
  const avatarEmoji = normalizeAvatarEmoji(input.avatarEmoji ?? null);
  if (avatarDataUrl !== null && avatarEmoji !== null) {
    throw new ApiError(400, 'VALIDATION_ERROR', '图片头像和 Emoji 头像不能同时设置');
  }
  const defaultDailyRateFen = assertRateFen(input.defaultDailyRateFen ?? 0, '默认日薪');
  const note = normalizeNote(input.note ?? '', '工人备注');
  if (input.defaultSiteId !== undefined && input.defaultSiteId !== null) {
    assertId(input.defaultSiteId, '默认工地 ID');
  }
  return store.mutate((data) => {
    if (input.defaultSiteId !== undefined && input.defaultSiteId !== null) {
      findSite(data, input.defaultSiteId);
    }
    const worker = {
      id: randomUUID(),
      name,
      avatarDataUrl,
      avatarEmoji,
      defaultDailyRateFen,
      note,
      defaultSiteId: input.defaultSiteId ?? null,
      createdAt: new Date().toISOString(),
      archivedAt: null,
    };
    data.workers.push(worker);
    if (data.settings.currentWorkerId === null) {
      data.settings.currentWorkerId = worker.id;
    }
  });
}

async function updateWorker(store, workerId, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, [
    'name',
    'avatarDataUrl',
    'avatarEmoji',
    'defaultDailyRateFen',
    'note',
    'defaultSiteId',
    'archived',
    'archivedAt',
  ]);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', '至少提供一个要修改的工人字段');
  }
  const changes = {};
  if ('name' in input) changes.name = normalizeName(input.name);
  if ('avatarDataUrl' in input) changes.avatarDataUrl = normalizeAvatarDataUrl(input.avatarDataUrl);
  if ('avatarEmoji' in input) changes.avatarEmoji = normalizeAvatarEmoji(input.avatarEmoji);
  if (changes.avatarDataUrl !== undefined && changes.avatarEmoji !== undefined &&
      changes.avatarDataUrl !== null && changes.avatarEmoji !== null) {
    throw new ApiError(400, 'VALIDATION_ERROR', '图片头像和 Emoji 头像不能同时设置');
  }
  if ('defaultDailyRateFen' in input) {
    changes.defaultDailyRateFen = assertRateFen(input.defaultDailyRateFen, '默认日薪');
  }
  if ('note' in input) changes.note = normalizeNote(input.note, '工人备注');
  if ('defaultSiteId' in input) {
    if (input.defaultSiteId !== null) assertId(input.defaultSiteId, '默认工地 ID');
    changes.defaultSiteId = input.defaultSiteId;
  }
  if ('archived' in input) {
    if (typeof input.archived !== 'boolean') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'archived 必须是 true 或 false');
    }
    changes.archived = input.archived;
  }
  if ('archivedAt' in input) {
    if (input.archivedAt !== null && typeof input.archivedAt !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'archivedAt 必须是时间文字或 null');
    }
    if (input.archivedAt !== null) assertTimestamp(input.archivedAt, '工人归档时间');
    if ('archived' in input && input.archived !== (input.archivedAt !== null)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'archived 与 archivedAt 的归档状态冲突');
    }
    changes.archived = input.archivedAt !== null;
  }
  return store.mutate((data) => {
    const worker = findWorker(data, workerId, { allowArchived: true });
    if (changes.name !== undefined) worker.name = changes.name;
    if (changes.avatarDataUrl !== undefined) {
      worker.avatarDataUrl = changes.avatarDataUrl;
      if (changes.avatarDataUrl !== null) worker.avatarEmoji = null;
    }
    if (changes.avatarEmoji !== undefined) {
      worker.avatarEmoji = changes.avatarEmoji;
      if (changes.avatarEmoji !== null) worker.avatarDataUrl = null;
    }
    if (changes.defaultDailyRateFen !== undefined) {
      worker.defaultDailyRateFen = changes.defaultDailyRateFen;
    }
    if (changes.note !== undefined) worker.note = changes.note;
    if (changes.defaultSiteId !== undefined) {
      if (changes.defaultSiteId !== null) findSite(data, changes.defaultSiteId);
      worker.defaultSiteId = changes.defaultSiteId;
    }
    if (changes.archived !== undefined) {
      worker.archivedAt = changes.archived ? worker.archivedAt ?? new Date().toISOString() : null;
      if (changes.archived && data.settings.currentWorkerId === worker.id) {
        data.settings.currentWorkerId =
          data.workers.find((candidate) => candidate.id !== worker.id && candidate.archivedAt === null)
            ?.id ?? null;
      } else if (!changes.archived && data.settings.currentWorkerId === null) {
        data.settings.currentWorkerId = worker.id;
      }
    }
  });
}

function normalizeAttendancePatch(value, label = '考勤补丁') {
  const input = assertPlainObject(value, label);
  assertAllowedKeys(input, ['workerId', 'date', ...ATTENDANCE_PATCH_FIELDS], label);
  assertId(input.workerId, 'workerId');
  const patch = { workerId: input.workerId, date: assertIsoDate(input.date) };
  const fields = ATTENDANCE_PATCH_FIELDS.filter((key) => Object.hasOwn(input, key));
  if (fields.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}至少包含一个要修改的字段`);
  }
  if (Object.hasOwn(input, 'morning')) patch.morning = assertStatus(input.morning);
  if (Object.hasOwn(input, 'afternoon')) patch.afternoon = assertStatus(input.afternoon);
  if (Object.hasOwn(input, 'overtime')) patch.overtime = assertOvertimeStatus(input.overtime);
  if (Object.hasOwn(input, 'dayNote')) patch.dayNote = normalizeDayNote(input.dayNote);
  for (const key of ['morningSiteId', 'afternoonSiteId', 'overtimeSiteId']) {
    if (!Object.hasOwn(input, key)) continue;
    if (input[key] !== null) assertId(input[key], key);
    patch[key] = input[key];
  }
  for (const [key, overtime] of [
    ['morningLeave', false],
    ['afternoonLeave', false],
    ['overtimeLeave', true],
  ]) {
    if (Object.hasOwn(input, key)) {
      patch[key] = normalizeLeave(input[key], { overtime, label: key });
    }
  }
  return patch;
}

function isAttendanceEntryEmpty(entry) {
  return (
    entry.morning === null &&
    entry.afternoon === null &&
    entry.overtime === null &&
    entry.dayNote === '' &&
    entry.morningSiteId === null &&
    entry.afternoonSiteId === null &&
    entry.overtimeSiteId === null &&
    entry.morningLeave === null &&
    entry.afternoonLeave === null &&
    entry.overtimeLeave === null
  );
}

function emptyAttendanceEntry(workerId, date) {
  return {
    workerId,
    date,
    morning: null,
    afternoon: null,
    overtime: null,
    dayNote: '',
    morningSiteId: null,
    afternoonSiteId: null,
    overtimeSiteId: null,
    morningLeave: null,
    afternoonLeave: null,
    overtimeLeave: null,
  };
}

function applyAttendancePatch(data, patch) {
  const worker = findWorker(data, patch.workerId);
  const entryIndex = data.attendance.findIndex(
    (candidate) => candidate.workerId === worker.id && candidate.date === patch.date,
  );
  const entry = entryIndex === -1 ? null : data.attendance[entryIndex];
  const original = entry ?? emptyAttendanceEntry(worker.id, patch.date);
  const next = { ...original };

  for (const period of PERIODS) {
    const statusChanged = Object.hasOwn(patch, period) &&
      !isDeepStrictEqual(patch[period], next[period]);
    const siteKey = `${period}SiteId`;
    const siteChanged = Object.hasOwn(patch, siteKey) &&
      !isDeepStrictEqual(patch[siteKey], next[siteKey]);
    const leaveKey = `${period}Leave`;
    const leaveChanged = Object.hasOwn(patch, leaveKey) &&
      !isDeepStrictEqual(patch[leaveKey], next[leaveKey]);
    if (leaveChanged || ((statusChanged || siteChanged) && next[leaveKey] !== null)) {
      throw new ApiError(409, 'LEAVE_LOCKED', '请假时段已锁定，请先使用“取消请假”');
    }
  }

  for (const statusKey of ['morning', 'afternoon', 'overtime']) {
    if (!Object.hasOwn(patch, statusKey)) continue;
    next[statusKey] = patch[statusKey];
    const siteKey = `${statusKey}SiteId`;
    const active = statusKey === 'overtime'
      ? patch[statusKey] === 'half' || patch[statusKey] === 'full'
      : patch[statusKey] === 'present';
    if (!active) {
      next[siteKey] = null;
    } else if (!Object.hasOwn(patch, siteKey) && next[siteKey] === null) {
      next[siteKey] = worker.defaultSiteId;
    }
  }
  if (Object.hasOwn(patch, 'dayNote')) next.dayNote = patch.dayNote;

  for (const [siteKey, statusKey] of [
    ['morningSiteId', 'morning'],
    ['afternoonSiteId', 'afternoon'],
    ['overtimeSiteId', 'overtime'],
  ]) {
    if (!Object.hasOwn(patch, siteKey)) continue;
    const siteId = patch[siteKey];
    const active = statusKey === 'overtime'
      ? next[statusKey] === 'half' || next[statusKey] === 'full'
      : next[statusKey] === 'present';
    if (siteId !== null && !active) {
      throw new ApiError(400, 'VALIDATION_ERROR', '只有出工或加班状态才能指定工地');
    }
    if (siteId !== null) {
      // Archived sites remain immutable historical references. The UI never
      // offers them for new choices, but undo/restore may need to put a prior
      // reference back after a clear operation.
      findSite(data, siteId, { allowArchived: true });
    }
    next[siteKey] = siteId;
  }

  if (isAttendanceEntryEmpty(next)) {
    if (entry) data.attendance.splice(entryIndex, 1);
    return;
  }
  if (entry) data.attendance[entryIndex] = next;
  else data.attendance.push(next);
  if (next.morning !== null || next.afternoon !== null || next.overtime !== null) {
    ensureMonthlyRecord(data, worker, patch.date.slice(0, 7));
  }
}

function normalizeLeavePatch(value, label = '请假补丁') {
  const input = assertPlainObject(value, label);
  assertAllowedKeys(input, ['workerId', 'date', 'period', 'leave'], label);
  const workerId = assertId(input.workerId, 'workerId');
  const date = assertIsoDate(input.date);
  if (!PERIODS.has(input.period)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'period 只能是 morning、afternoon 或 overtime');
  }
  if (!Object.hasOwn(input, 'leave')) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须包含 leave`);
  }
  const leave = normalizeLeave(input.leave, {
    overtime: input.period === 'overtime',
    label: `${label} leave`,
  });
  return { workerId, date, period: input.period, leave };
}

function applyLeavePatch(data, patch) {
  const worker = findWorker(data, patch.workerId);
  const entryIndex = data.attendance.findIndex(
    (candidate) => candidate.workerId === worker.id && candidate.date === patch.date,
  );
  const entry = entryIndex === -1 ? null : data.attendance[entryIndex];
  const next = { ...(entry ?? emptyAttendanceEntry(worker.id, patch.date)) };
  const leaveKey = `${patch.period}Leave`;
  next[leaveKey] = patch.leave;
  if (patch.leave !== null) {
    next[patch.period] = null;
    next[`${patch.period}SiteId`] = null;
  }
  if (isAttendanceEntryEmpty(next)) {
    if (entry) data.attendance.splice(entryIndex, 1);
    return;
  }
  if (entry) data.attendance[entryIndex] = next;
  else data.attendance.push(next);
  if (patch.leave?.payType === 'paid') {
    ensureMonthlyRecord(data, worker, patch.date.slice(0, 7));
  }
}

function assertFutureAttendanceAllowed(patches, allowFuture, now = new Date()) {
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const futureDates = [...new Set(patches.filter((patch) => patch.date > today).map((patch) => patch.date))]
    .sort();
  if (futureDates.length > 0 && allowFuture !== true) {
    throw new ApiError(
      409,
      'FUTURE_ATTENDANCE_CONFIRMATION_REQUIRED',
      '未来日期的记录需要先确认',
      { today, dates: futureDates },
    );
  }
}

async function updateAttendanceBatch(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['patches', 'allowFuture']);
  if ('allowFuture' in input && typeof input.allowFuture !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'allowFuture 必须是 true 或 false');
  }
  if (!Array.isArray(input.patches) || input.patches.length < 1 || input.patches.length > MAX_ATTENDANCE_PATCHES) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `patches 必须是包含 1 至 ${MAX_ATTENDANCE_PATCHES} 项的数组`,
    );
  }
  const patches = input.patches.map((patch, index) => normalizeAttendancePatch(patch, `考勤补丁 ${index + 1}`));
  const seen = new Set();
  for (const patch of patches) {
    const key = `${patch.workerId}\u0000${patch.date}`;
    if (seen.has(key)) {
      throw new ApiError(400, 'VALIDATION_ERROR', '同一批次不能重复修改同一工人的同一天');
    }
    seen.add(key);
  }
  const now = typeof store.now === 'function' ? store.now() : new Date();
  assertFutureAttendanceAllowed(patches, input.allowFuture, now);
  return store.mutateAttendance((data) => {
    for (const patch of patches) applyAttendancePatch(data, patch);
  });
}

async function updateAttendance(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['workerId', 'date', 'period', 'status', 'siteId', 'allowFuture']);
  assertId(input.workerId, 'workerId');
  const date = assertIsoDate(input.date);
  if (!PERIODS.has(input.period)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'period 只能是 morning、afternoon 或 overtime');
  }
  const status = input.period === 'overtime' ? assertOvertimeStatus(input.status) : assertStatus(input.status);
  const patch = { workerId: input.workerId, date, [input.period]: status };
  if (Object.hasOwn(input, 'siteId')) patch[`${input.period}SiteId`] = input.siteId;
  return updateAttendanceBatch(store, {
    patches: [patch],
    ...(Object.hasOwn(input, 'allowFuture') ? { allowFuture: input.allowFuture } : {}),
  });
}

async function updateAttendanceLeave(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['patches', 'allowFuture']);
  if ('allowFuture' in input && typeof input.allowFuture !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'allowFuture 必须是 true 或 false');
  }
  if (
    !Array.isArray(input.patches) || input.patches.length < 1 ||
    input.patches.length > MAX_ATTENDANCE_PATCHES
  ) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `patches 必须是包含 1 至 ${MAX_ATTENDANCE_PATCHES} 项的数组`,
    );
  }
  const patches = input.patches.map((patch, index) =>
    normalizeLeavePatch(patch, `请假补丁 ${index + 1}`));
  const seen = new Set();
  for (const patch of patches) {
    const key = `${patch.workerId}\0${patch.date}\0${patch.period}`;
    if (seen.has(key)) {
      throw new ApiError(400, 'VALIDATION_ERROR', '同一批次不能重复修改同一请假时段');
    }
    seen.add(key);
  }
  const now = typeof store.now === 'function' ? store.now() : new Date();
  assertFutureAttendanceAllowed(patches, input.allowFuture, now);
  return store.mutateAttendance((data) => {
    for (const patch of patches) applyLeavePatch(data, patch);
  });
}

async function updateDayNote(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['workerId', 'date', 'dayNote']);
  return updateAttendanceBatch(store, {
    patches: [{ workerId: input.workerId, date: input.date, dayNote: input.dayNote }],
  });
}

async function updateMonthlyRecord(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['workerId', 'month', 'dailyRateFen', 'overtimePayPercent', 'note', 'paid']);
  if (typeof input.workerId !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'workerId 必须是文字');
  }
  const month = assertIsoMonth(input.month);
  if (
    !('dailyRateFen' in input) && !('overtimePayPercent' in input) &&
    !('note' in input) && !('paid' in input)
  ) {
    throw new ApiError(400, 'VALIDATION_ERROR', '至少提供日薪、加班倍率、月度备注或结清状态');
  }
  const rate = 'dailyRateFen' in input ? assertRateFen(input.dailyRateFen, '月度日薪') : undefined;
  const overtimePayPercent = 'overtimePayPercent' in input
    ? assertOvertimePayPercent(input.overtimePayPercent, '月度加班倍率')
    : undefined;
  const note = 'note' in input ? normalizeNote(input.note, '月度备注') : undefined;
  if ('paid' in input && typeof input.paid !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'paid 必须是 true 或 false');
  }
  return store.mutate((data) => {
    const worker = findWorker(data, input.workerId);
    let monthly = data.monthlyRecords.find(
      (record) => record.workerId === worker.id && record.month === month,
    );
    let changed = false;
    if (!monthly) {
      const effectiveRate = resolveEffectiveDailyRate(data, worker, month).rateFen;
      const isSemanticNoOp =
        (rate === undefined || rate === effectiveRate) &&
        (overtimePayPercent === undefined ||
          overtimePayPercent === data.settings.defaultOvertimePayPercent) &&
        (note === undefined || note === '') &&
        (!Object.hasOwn(input, 'paid') || input.paid === false);
      if (isSemanticNoOp) return false;
      monthly = ensureMonthlyRecord(data, worker, month);
      changed = true;
    }
    if (rate !== undefined && monthly.dailyRateFen !== rate) {
      monthly.dailyRateFen = rate;
      changed = true;
    }
    if (overtimePayPercent !== undefined && monthly.overtimePayPercent !== overtimePayPercent) {
      monthly.overtimePayPercent = overtimePayPercent;
      changed = true;
    }
    if (note !== undefined && monthly.note !== note) {
      monthly.note = note;
      changed = true;
    }
    if ('paid' in input) {
      const now = typeof store.now === 'function' ? store.now() : new Date();
      const paidAt = input.paid ? monthly.paidAt ?? now.toISOString() : null;
      if (monthly.paidAt !== paidAt) {
        monthly.paidAt = paidAt;
        changed = true;
      }
    }
    return changed;
  });
}

async function updateSettings(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, [
    'weekStartsOn',
    'currentWorkerId',
    'theme',
    'sidebarCollapsed',
    'lastBackupExportAt',
    'lastBackupReminderAt',
    'weeklyAutoBackupEnabled',
    'defaultOvertimePayPercent',
  ]);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', '至少提供一个要修改的设置');
  }
  const weekStartsOn =
    'weekStartsOn' in input ? assertWeekStartsOn(input.weekStartsOn) : undefined;
  const theme = 'theme' in input ? assertTheme(input.theme) : undefined;
  if ('sidebarCollapsed' in input && typeof input.sidebarCollapsed !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'sidebarCollapsed 必须是 true 或 false');
  }
  if ('weeklyAutoBackupEnabled' in input && typeof input.weeklyAutoBackupEnabled !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'weeklyAutoBackupEnabled 必须是 true 或 false');
  }
  const defaultOvertimePayPercent = 'defaultOvertimePayPercent' in input
    ? assertOvertimePayPercent(input.defaultOvertimePayPercent, '默认加班倍率')
    : undefined;
  if ('lastBackupExportAt' in input) {
    assertNullableTimestamp(input.lastBackupExportAt, '上次导出时间');
  }
  if ('lastBackupReminderAt' in input) {
    assertNullableTimestamp(input.lastBackupReminderAt, '上次备份提醒时间');
  }
  if (
    'currentWorkerId' in input &&
    input.currentWorkerId !== null &&
    typeof input.currentWorkerId !== 'string'
  ) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'currentWorkerId 必须是工人 ID 或 null');
  }
  return store.mutate((data) => {
    if (weekStartsOn !== undefined) data.settings.weekStartsOn = weekStartsOn;
    if (theme !== undefined) data.settings.theme = theme;
    if ('sidebarCollapsed' in input) data.settings.sidebarCollapsed = input.sidebarCollapsed;
    if ('lastBackupExportAt' in input) data.settings.lastBackupExportAt = input.lastBackupExportAt;
    if ('lastBackupReminderAt' in input) {
      data.settings.lastBackupReminderAt = input.lastBackupReminderAt;
    }
    if ('weeklyAutoBackupEnabled' in input) {
      data.settings.weeklyAutoBackupEnabled = input.weeklyAutoBackupEnabled;
    }
    if (defaultOvertimePayPercent !== undefined) {
      data.settings.defaultOvertimePayPercent = defaultOvertimePayPercent;
    }
    if ('currentWorkerId' in input) {
      if (input.currentWorkerId !== null) findWorker(data, input.currentWorkerId);
      data.settings.currentWorkerId = input.currentWorkerId;
    }
  });
}

function normalizePayAdjustmentInput(body, { partial = false } = {}) {
  const input = assertPlainObject(body);
  assertAllowedKeys(
    input,
    partial
      ? ['month', 'date', 'kind', 'amountFen', 'label', 'note', 'siteId']
      : ['workerId', 'month', 'date', 'kind', 'amountFen', 'label', 'note', 'siteId'],
  );
  if (partial && Object.keys(input).length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', '至少提供一个要修改的补贴扣款字段');
  }
  const required = ['workerId', 'month', 'kind', 'amountFen', 'label'];
  if (!partial) {
    const missing = required.filter((key) => !Object.hasOwn(input, key));
    if (missing.length > 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', '补贴扣款缺少必填字段', { fields: missing });
    }
  }
  const changes = {};
  if ('workerId' in input) changes.workerId = assertId(input.workerId, 'workerId');
  if ('month' in input) changes.month = assertIsoMonth(input.month);
  if ('date' in input) {
    changes.date = input.date === null ? null : assertIsoDate(input.date);
  }
  if ('kind' in input) changes.kind = assertPayAdjustmentKind(input.kind);
  if ('amountFen' in input) changes.amountFen = assertPositiveAmountFen(input.amountFen, '补贴扣款金额');
  if ('label' in input) changes.label = normalizeLabel(input.label, '补贴扣款项目');
  if ('note' in input) changes.note = normalizeNote(input.note, '补贴扣款备注');
  if ('siteId' in input) {
    changes.siteId = input.siteId === null ? null : assertId(input.siteId, '补贴扣款工地 ID');
  }
  return changes;
}

function assertAdjustmentDateMonth(adjustment) {
  if (adjustment.date !== null && adjustment.date.slice(0, 7) !== adjustment.month) {
    throw new ApiError(400, 'VALIDATION_ERROR', '补贴扣款日期必须属于所选月份');
  }
}

async function addPayAdjustment(store, body) {
  const changes = normalizePayAdjustmentInput(body);
  return store.mutate((data) => {
    findWorker(data, changes.workerId);
    if (changes.siteId !== undefined && changes.siteId !== null) findSite(data, changes.siteId);
    const now = new Date().toISOString();
    const adjustment = {
      id: randomUUID(),
      workerId: changes.workerId,
      month: changes.month,
      date: changes.date ?? null,
      kind: changes.kind,
      amountFen: changes.amountFen,
      label: changes.label,
      note: changes.note ?? '',
      siteId: changes.siteId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    assertAdjustmentDateMonth(adjustment);
    data.payAdjustments.push(adjustment);
    ensureMonthlyRecord(data, findWorker(data, adjustment.workerId), adjustment.month);
  });
}

async function updatePayAdjustment(store, adjustmentId, body) {
  const changes = normalizePayAdjustmentInput(body, { partial: true });
  return store.mutate((data) => {
    const adjustment = findPayAdjustment(data, adjustmentId);
    const candidate = { ...adjustment, ...changes };
    findWorker(data, candidate.workerId);
    if (changes.siteId !== undefined && changes.siteId !== null) findSite(data, changes.siteId);
    assertAdjustmentDateMonth(candidate);
    Object.assign(adjustment, changes, { updatedAt: new Date().toISOString() });
    ensureMonthlyRecord(data, findWorker(data, adjustment.workerId), adjustment.month);
  });
}

async function deletePayAdjustment(store, adjustmentId) {
  return store.mutate((data) => {
    const adjustment = findPayAdjustment(data, adjustmentId);
    data.payAdjustments = data.payAdjustments.filter((candidate) => candidate !== adjustment);
  });
}

async function addSite(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['name', 'note']);
  const name = normalizeLabel(input.name, '工地名称');
  const note = normalizeNote(input.note ?? '', '工地备注');
  return store.mutate((data) => {
    data.sites.push({
      id: randomUUID(),
      name,
      note,
      createdAt: new Date().toISOString(),
      archivedAt: null,
    });
  });
}

async function updateSite(store, siteId, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['name', 'note', 'archived', 'replacementDefaultSiteId']);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', '至少提供一个要修改的工地字段');
  }
  const changes = {};
  if ('name' in input) changes.name = normalizeLabel(input.name, '工地名称');
  if ('note' in input) changes.note = normalizeNote(input.note, '工地备注');
  if ('archived' in input) {
    if (typeof input.archived !== 'boolean') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'archived 必须是 true 或 false');
    }
    changes.archived = input.archived;
  }
  if ('replacementDefaultSiteId' in input) {
    changes.replacementDefaultSiteId = input.replacementDefaultSiteId === null
      ? null
      : assertId(input.replacementDefaultSiteId, '替代默认工地 ID');
  }
  if (changes.replacementDefaultSiteId !== undefined && changes.archived !== true) {
    throw new ApiError(400, 'VALIDATION_ERROR', '替代默认工地只用于归档工地');
  }
  return store.mutate((data) => {
    const site = findSite(data, siteId, { allowArchived: true });
    if (changes.name !== undefined) site.name = changes.name;
    if (changes.note !== undefined) site.note = changes.note;
    if (changes.archived !== undefined) {
      const affectedWorkers = data.workers.filter((worker) => worker.defaultSiteId === site.id);
      if (changes.archived && affectedWorkers.length && !Object.hasOwn(input, 'replacementDefaultSiteId')) {
        throw new ApiError(400, 'SITE_REASSIGN_REQUIRED', `归档前必须处理 ${affectedWorkers.length} 名工人的默认工地`);
      }
      if (changes.archived && changes.replacementDefaultSiteId !== null && changes.replacementDefaultSiteId !== undefined) {
        if (changes.replacementDefaultSiteId === site.id) {
          throw new ApiError(400, 'VALIDATION_ERROR', '不能把默认工地重新分配到正在归档的工地');
        }
        findSite(data, changes.replacementDefaultSiteId);
      }
      site.archivedAt = changes.archived ? site.archivedAt ?? new Date().toISOString() : null;
      if (changes.archived) {
        for (const worker of affectedWorkers) worker.defaultSiteId = changes.replacementDefaultSiteId ?? null;
      }
    }
  });
}

function normalizeSiteArchiveSnapshot(value, key, label) {
  const input = assertPlainObject(value, label);
  assertAllowedKeys(input, ['archivedAt', 'workerDefaults'], label);
  const archivedAt = assertNullableTimestamp(input.archivedAt, `${label}归档时间`);
  if (!Array.isArray(input.workerDefaults) || input.workerDefaults.length > 10_000) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label} workerDefaults 无效`);
  }
  const workerDefaults = input.workerDefaults.map((raw, index) => {
    const item = assertPlainObject(raw, `${label} workerDefaults ${index + 1}`);
    assertAllowedKeys(item, ['workerId', 'defaultSiteId'], `${label} workerDefaults ${index + 1}`);
    return {
      workerId: assertId(item.workerId, `${label} workerId`),
      defaultSiteId: item.defaultSiteId === null ? null : assertId(item.defaultSiteId, `${label} defaultSiteId`),
    };
  }).sort((left, right) => left.workerId.localeCompare(right.workerId));
  if (new Set(workerDefaults.map((item) => item.workerId)).size !== workerDefaults.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}包含重复工人`);
  }
  return { archivedAt, workerDefaults };
}

function normalizeMonthlyHistorySnapshot(value, key, label) {
  if (value === null) return null;
  const input = assertPlainObject(value, label);
  assertAllowedKeys(
    input,
    ['workerId', 'month', 'dailyRateFen', 'overtimePayPercent', 'note', 'paidAt'],
    label,
  );
  const snapshot = {
    workerId: assertId(input.workerId, `${label} workerId`),
    month: assertIsoMonth(input.month, `${label} month`),
    dailyRateFen: assertRateFen(input.dailyRateFen, `${label}日薪`),
    overtimePayPercent: assertOvertimePayPercent(input.overtimePayPercent, `${label}加班倍率`),
    note: normalizeNote(input.note, `${label}备注`),
    paidAt: assertNullableTimestamp(input.paidAt, `${label}结清时间`),
  };
  if (snapshot.workerId !== key.workerId || snapshot.month !== key.month) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}与目标月度记录键不一致`);
  }
  return snapshot;
}

function normalizeAdjustmentHistorySnapshot(value, key, label) {
  if (value === null) return null;
  const input = assertPlainObject(value, label);
  assertAllowedKeys(
    input,
    [
      'id', 'workerId', 'month', 'date', 'kind', 'amountFen', 'label', 'note',
      'siteId', 'createdAt', 'updatedAt',
    ],
    label,
  );
  const snapshot = {
    id: assertId(input.id, `${label} ID`),
    workerId: assertId(input.workerId, `${label} workerId`),
    month: assertIsoMonth(input.month, `${label}月份`),
    date: input.date === null ? null : assertIsoDate(input.date, `${label}日期`),
    kind: assertPayAdjustmentKind(input.kind),
    amountFen: assertPositiveAmountFen(input.amountFen, `${label}金额`),
    label: normalizeLabel(input.label, `${label}项目`),
    note: normalizeNote(input.note, `${label}备注`),
    siteId: input.siteId === undefined || input.siteId === null
      ? null
      : assertId(input.siteId, `${label}工地 ID`),
    createdAt: assertTimestamp(input.createdAt, `${label}创建时间`),
    updatedAt: assertTimestamp(input.updatedAt, `${label}更新时间`),
  };
  if (snapshot.id !== key.id) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}与目标补贴扣款键不一致`);
  }
  assertAdjustmentDateMonth(snapshot);
  if (Date.parse(snapshot.updatedAt) < Date.parse(snapshot.createdAt)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}更新时间不能早于创建时间`);
  }
  return snapshot;
}

function normalizeAttendanceHistoryField(field, value, label) {
  if (field === 'morning' || field === 'afternoon') return assertStatus(value);
  if (field === 'overtime') return assertOvertimeStatus(value);
  if (field === 'dayNote') return normalizeDayNote(value);
  if (field.endsWith('SiteId')) return value === null ? null : assertId(value, label);
  if (field === 'morningLeave' || field === 'afternoonLeave') {
    return normalizeLeave(value, { label });
  }
  if (field === 'overtimeLeave') return normalizeLeave(value, { overtime: true, label });
  throw new ApiError(400, 'VALIDATION_ERROR', `${label}字段无效`);
}

function normalizeAttendanceHistorySnapshots(input, key, label) {
  const beforeInput = assertPlainObject(input.before, `${label} before`);
  const afterInput = assertPlainObject(input.after, `${label} after`);
  const allowedSnapshotKeys = ['workerId', 'date', ...ATTENDANCE_HISTORY_FIELDS];
  assertAllowedKeys(beforeInput, allowedSnapshotKeys, `${label} before`);
  assertAllowedKeys(afterInput, allowedSnapshotKeys, `${label} after`);
  for (const snapshot of [beforeInput, afterInput]) {
    if (Object.hasOwn(snapshot, 'workerId') && snapshot.workerId !== key.workerId) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${label}快照的 workerId 与 key 不一致`);
    }
    if (Object.hasOwn(snapshot, 'date') && snapshot.date !== key.date) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${label}快照的 date 与 key 不一致`);
    }
  }
  let fields;
  if (Object.hasOwn(input, 'fields')) {
    if (!Array.isArray(input.fields) || input.fields.length < 1) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${label} fields 必须是非空数组`);
    }
    fields = [...input.fields];
  } else {
    fields = [...new Set([
      ...Object.keys(beforeInput),
      ...Object.keys(afterInput),
    ].filter((field) => field !== 'workerId' && field !== 'date'))];
  }
  if (
    fields.length < 1 || fields.some((field) => !ATTENDANCE_HISTORY_FIELDS.includes(field)) ||
    new Set(fields).size !== fields.length
  ) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label} fields 包含重复或不支持的考勤字段`);
  }
  const before = {};
  const after = {};
  for (const field of fields) {
    if (!Object.hasOwn(beforeInput, field) || !Object.hasOwn(afterInput, field)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${label} before/after 必须都包含 ${field}`);
    }
    before[field] = normalizeAttendanceHistoryField(field, beforeInput[field], `${label} before ${field}`);
    after[field] = normalizeAttendanceHistoryField(field, afterInput[field], `${label} after ${field}`);
  }
  return { fields, before, after };
}

function normalizeHistoryRevertTarget(value, index) {
  const label = `撤销目标 ${index + 1}`;
  const input = assertPlainObject(value, label);
  assertAllowedKeys(input, ['entity', 'key', 'fields', 'before', 'after'], label);
  if (!Object.hasOwn(input, 'before') || !Object.hasOwn(input, 'after')) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须同时包含 before 和 after`);
  }
  const key = assertPlainObject(input.key, `${label} key`);
  let target;
  if (input.entity === 'attendance') {
    assertAllowedKeys(key, ['workerId', 'date'], `${label} key`);
    const normalizedKey = {
      workerId: assertId(key.workerId, `${label} workerId`),
      date: assertIsoDate(key.date, `${label} date`),
    };
    const snapshots = normalizeAttendanceHistorySnapshots(input, normalizedKey, label);
    target = { entity: input.entity, key: normalizedKey, ...snapshots };
  } else if (input.entity === 'monthlyRecord') {
    if (Object.hasOwn(input, 'fields')) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${label} fields 仅用于考勤撤销`);
    }
    assertAllowedKeys(key, ['workerId', 'month'], `${label} key`);
    const normalizedKey = {
      workerId: assertId(key.workerId, `${label} workerId`),
      month: assertIsoMonth(key.month, `${label} month`),
    };
    target = {
      entity: input.entity,
      key: normalizedKey,
      before: normalizeMonthlyHistorySnapshot(input.before, normalizedKey, `${label} before`),
      after: normalizeMonthlyHistorySnapshot(input.after, normalizedKey, `${label} after`),
    };
  } else if (input.entity === 'payAdjustment') {
    assertAllowedKeys(key, ['id'], `${label} key`);
    const normalizedKey = { id: assertId(key.id, `${label} id`) };
    target = {
      entity: input.entity,
      key: normalizedKey,
      before: normalizeAdjustmentHistorySnapshot(input.before, normalizedKey, `${label} before`),
      after: normalizeAdjustmentHistorySnapshot(input.after, normalizedKey, `${label} after`),
    };
  } else if (input.entity === 'siteArchive') {
    if (Object.hasOwn(input, 'fields')) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${label} fields 仅用于考勤撤销`);
    }
    assertAllowedKeys(key, ['id'], `${label} key`);
    const normalizedKey = { id: assertId(key.id, `${label} id`) };
    const before = normalizeSiteArchiveSnapshot(input.before, normalizedKey, `${label} before`);
    const after = normalizeSiteArchiveSnapshot(input.after, normalizedKey, `${label} after`);
    if (before.workerDefaults.map((item) => item.workerId).join('\0') !== after.workerDefaults.map((item) => item.workerId).join('\0')) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${label}前后工人集合不一致`);
    }
    target = { entity: input.entity, key: normalizedKey, before, after };
  } else {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label} entity 无效`);
  }
  if (isDeepStrictEqual(target.before, target.after)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}没有可撤销的变化`);
  }
  return target;
}

function currentHistoryEntity(data, target) {
  if (target.entity === 'monthlyRecord') {
    return data.monthlyRecords.find(
      (record) => record.workerId === target.key.workerId && record.month === target.key.month,
    ) ?? null;
  }
  if (target.entity === 'attendance') {
    const entry = data.attendance.find(
      (candidate) => candidate.workerId === target.key.workerId && candidate.date === target.key.date,
    ) ?? emptyAttendanceEntry(target.key.workerId, target.key.date);
    return Object.fromEntries(target.fields.map((field) => [field, structuredClone(entry[field])]));
  }
  if (target.entity === 'siteArchive') {
    const site = findSite(data, target.key.id, { allowArchived: true });
    return {
      archivedAt: site.archivedAt,
      workerDefaults: target.after.workerDefaults.map(({ workerId }) => {
        const worker = findWorker(data, workerId, { allowArchived: true });
        return { workerId, defaultSiteId: worker.defaultSiteId };
      }).sort((left, right) => left.workerId.localeCompare(right.workerId)),
    };
  }
  return data.payAdjustments.find((adjustment) => adjustment.id === target.key.id) ?? null;
}

function replaceHistoryEntity(data, target) {
  if (target.entity === 'monthlyRecord') {
    data.monthlyRecords = data.monthlyRecords.filter(
      (record) => record.workerId !== target.key.workerId || record.month !== target.key.month,
    );
    if (target.before) data.monthlyRecords.push(structuredClone(target.before));
    return;
  }
  if (target.entity === 'attendance') {
    let entry = data.attendance.find(
      (candidate) => candidate.workerId === target.key.workerId && candidate.date === target.key.date,
    );
    const next = { ...(entry ?? emptyAttendanceEntry(target.key.workerId, target.key.date)) };
    for (const field of target.fields) next[field] = structuredClone(target.before[field]);
    if (isAttendanceEntryEmpty(next)) {
      if (entry) data.attendance = data.attendance.filter((candidate) => candidate !== entry);
    } else if (entry) {
      Object.assign(entry, next);
    } else {
      data.attendance.push(next);
    }
    return;
  }
  if (target.entity === 'siteArchive') {
    const site = findSite(data, target.key.id, { allowArchived: true });
    site.archivedAt = target.before.archivedAt;
    for (const item of target.before.workerDefaults) {
      const worker = findWorker(data, item.workerId, { allowArchived: true });
      if (item.defaultSiteId !== null) findSite(data, item.defaultSiteId, { allowArchived: true });
      worker.defaultSiteId = item.defaultSiteId;
    }
    return;
  }
  data.payAdjustments = data.payAdjustments.filter((adjustment) => adjustment.id !== target.key.id);
  if (target.before) data.payAdjustments.push(structuredClone(target.before));
}

async function revertHistory(store, body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['targets']);
  if (
    !Array.isArray(input.targets) || input.targets.length < 1 ||
    input.targets.length > MAX_HISTORY_REVERT_TARGETS
  ) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `targets 必须是包含 1 至 ${MAX_HISTORY_REVERT_TARGETS} 项的数组`,
    );
  }
  const targets = input.targets.map(normalizeHistoryRevertTarget);
  const seen = new Set();
  for (const target of targets) {
    const key = target.entity === 'monthlyRecord'
      ? `${target.entity}\0${target.key.workerId}\0${target.key.month}`
      : target.entity === 'attendance'
        ? `${target.entity}\0${target.key.workerId}\0${target.key.date}`
        : `${target.entity}\0${target.key.id}`;
    if (seen.has(key)) throw new ApiError(400, 'VALIDATION_ERROR', '同一实体不能在一次撤销中重复出现');
    seen.add(key);
  }

  return store.mutate((data) => {
    const applyTargets = [];
    for (const target of targets) {
      const current = currentHistoryEntity(data, target);
      if (isDeepStrictEqual(current, target.before)) continue;
      if (!isDeepStrictEqual(current, target.after)) {
        throw new ApiError(409, 'UNDO_CONFLICT', '目标数据已经发生变化，无法安全撤销');
      }
      applyTargets.push(target);
    }
    for (const target of applyTargets) replaceHistoryEntity(data, target);
    return applyTargets.length > 0;
  });
}

function inspectBackup(body) {
  const input = assertPlainObject(body);
  assertAllowedKeys(input, ['data']);
  if (!Object.hasOwn(input, 'data')) {
    throw new ApiError(400, 'VALIDATION_ERROR', '缺少要检查的备份 data');
  }
  const data = validateAppData(input.data);
  return {
    data,
    workerCount: data.workers.length,
    archivedWorkerCount: data.workers.filter((worker) => worker.archivedAt !== null).length,
    attendanceCount: data.attendance.length,
    monthCount: data.monthlyRecords.length,
    adjustmentCount: data.payAdjustments.length,
    siteCount: data.sites.length,
    workerNames: data.workers.map((worker) => worker.name),
  };
}

async function restoreBackup(store, body) {
  const input = assertPlainObject(body);
  const candidate = Object.hasOwn(input, 'data') ? input.data : input;
  if (Object.hasOwn(input, 'data')) {
    assertAllowedKeys(input, ['data']);
  }
  return store.restore(candidate);
}

function backupFilename() {
  const date = new Date();
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
  return `记工本备份_${stamp}.json`;
}

async function handleApi(request, response, url, store, host) {
  const method = request.method ?? 'GET';
  if (url.pathname === '/api/health' && method === 'GET') {
    const status = await store.getStatus();
    sendJson(response, status.ok ? 200 : 503, status);
    return;
  }
  if (url.pathname === '/api/state' && method === 'GET') {
    if (store.isReadOnly) {
      sendJson(response, 503, await store.getCorruptionResponse());
    } else {
      sendJson(response, 200, store.getState());
    }
    return;
  }
  if ((url.pathname === '/api/backup' || url.pathname === '/api/state/backup') && method === 'GET') {
    if (store.isReadOnly) {
      sendJson(response, 503, await store.getCorruptionResponse());
      return;
    }
    sendJson(response, 200, store.getState(), {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(backupFilename())}`,
    });
    return;
  }
  if (url.pathname === '/api/internal-backups' && method === 'GET') {
    sendJson(response, 200, { items: await store.listRecoverableBackups() });
    return;
  }
  if (url.pathname === '/api/internal-backups/inspect' && method === 'POST') {
    assertSameOriginMutation(request, host);
    const body = assertPlainObject(await readJson(request));
    assertAllowedKeys(body, ['id']);
    const { backup, data } = await store.inspectRecoverableBackup(body.id);
    const inspected = inspectBackup({ data });
    sendJson(response, 200, {
      backup,
      ...inspected,
      schemaVersion: inspected.data.schemaVersion,
    });
    return;
  }

  const workerMatch = /^\/api\/workers\/([^/]+)$/.exec(url.pathname);
  const adjustmentMatch = /^\/api\/pay-adjustments\/([^/]+)$/.exec(url.pathname);
  const siteMatch = /^\/api\/sites\/([^/]+)$/.exec(url.pathname);
  const isMutation =
    (url.pathname === '/api/workers' && method === 'POST') ||
    (workerMatch && method === 'PATCH') ||
    (url.pathname === '/api/attendance' && method === 'PUT') ||
    (url.pathname === '/api/attendance/batch' && method === 'PUT') ||
    (url.pathname === '/api/attendance/leave' && method === 'PUT') ||
    (url.pathname === '/api/attendance/day-note' && method === 'PUT') ||
    (url.pathname === '/api/monthly-records' && method === 'PUT') ||
    (url.pathname === '/api/settings' && method === 'PUT') ||
    (url.pathname === '/api/history/revert' && method === 'POST') ||
    (url.pathname === '/api/restore' && method === 'POST') ||
    (url.pathname === '/api/restore/inspect' && method === 'POST') ||
    (url.pathname === '/api/pay-adjustments' && method === 'POST') ||
    (adjustmentMatch && (method === 'PATCH' || method === 'DELETE')) ||
    (url.pathname === '/api/sites' && method === 'POST') ||
    (siteMatch && method === 'PATCH');

  if (isMutation) {
    const bodyRequired = !(adjustmentMatch && method === 'DELETE');
    assertSameOriginMutation(request, host, { bodyRequired });
    const body = bodyRequired ? await readJson(request) : {};
    const operation = mutationOperation(request, method, url.pathname, body);
    const wantsDelta = request.headers['x-lq-response-mode'] === 'delta'
      && url.pathname !== '/api/restore'
      && url.pathname !== '/api/restore/inspect';
    const selectedDeltaKeys = wantsDelta ? attendanceDeltaKeys(url.pathname, body) : null;
    const usesSelectedDelta = Boolean(selectedDeltaKeys && operation);
    if (operation) {
      operation.responseMode = wantsDelta ? 'delta' : 'full';
      if (usesSelectedDelta) operation.deltaKeys = selectedDeltaKeys;
    }
    const beforeState = wantsDelta && !usesSelectedDelta && !store.isReadOnly
      ? store.getState()
      : null;
    const state = await store.runWithOperation(operation, async () => {
      if (url.pathname === '/api/workers') return addWorker(store, body);
      if (workerMatch) {
        let workerId;
        try {
          workerId = decodeURIComponent(workerMatch[1]);
        } catch {
          throw new ApiError(400, 'VALIDATION_ERROR', '工人 ID 编码无效');
        }
        return updateWorker(store, workerId, body);
      }
      if (url.pathname === '/api/attendance') return updateAttendance(store, body);
      if (url.pathname === '/api/attendance/batch') return updateAttendanceBatch(store, body);
      if (url.pathname === '/api/attendance/leave') return updateAttendanceLeave(store, body);
      if (url.pathname === '/api/attendance/day-note') return updateDayNote(store, body);
      if (url.pathname === '/api/monthly-records') return updateMonthlyRecord(store, body);
      if (url.pathname === '/api/settings') return updateSettings(store, body);
      if (url.pathname === '/api/history/revert') return revertHistory(store, body);
      if (url.pathname === '/api/restore') return restoreBackup(store, body);
      if (url.pathname === '/api/restore/inspect') return inspectBackup(body);
      if (url.pathname === '/api/pay-adjustments') return addPayAdjustment(store, body);
      if (adjustmentMatch) {
        let adjustmentId;
        try {
          adjustmentId = decodeURIComponent(adjustmentMatch[1]);
        } catch {
          throw new ApiError(400, 'VALIDATION_ERROR', '补贴扣款 ID 编码无效');
        }
        return method === 'DELETE'
          ? deletePayAdjustment(store, adjustmentId)
          : updatePayAdjustment(store, adjustmentId, body);
      }
      if (url.pathname === '/api/sites') return addSite(store, body);
      if (siteMatch) {
        let siteId;
        try {
          siteId = decodeURIComponent(siteMatch[1]);
        } catch {
          throw new ApiError(400, 'VALIDATION_ERROR', '工地 ID 编码无效');
        }
        return updateSite(store, siteId, body);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    });
    sendJson(
      response,
      200,
      wantsDelta && !operation?.duplicate
        ? usesSelectedDelta && operation?.deltaBeforeState
          ? buildAppDataDeltaForKeys(
              operation.deltaBeforeState,
              snapshotAppDataForKeys(state, selectedDeltaKeys),
              selectedDeltaKeys,
            )
          : beforeState
            ? buildAppDataDelta(beforeState, state)
            : state
        : state,
    );
    return;
  }

  const knownPath =
    url.pathname === '/api/health' ||
    url.pathname === '/api/state' ||
    url.pathname === '/api/backup' ||
    url.pathname === '/api/state/backup' ||
    url.pathname === '/api/internal-backups' ||
    url.pathname === '/api/internal-backups/inspect' ||
    url.pathname === '/api/workers' ||
    workerMatch ||
    url.pathname === '/api/attendance' ||
    url.pathname === '/api/attendance/batch' ||
    url.pathname === '/api/attendance/leave' ||
    url.pathname === '/api/attendance/day-note' ||
    url.pathname === '/api/monthly-records' ||
    url.pathname === '/api/settings' ||
    url.pathname === '/api/history/revert' ||
    url.pathname === '/api/restore' ||
    url.pathname === '/api/restore/inspect' ||
    url.pathname === '/api/pay-adjustments' ||
    adjustmentMatch ||
    url.pathname === '/api/sites' ||
    siteMatch;
  if (knownPath) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法');
  }
  throw new ApiError(404, 'NOT_FOUND', '接口不存在');
}

async function serveStatic(request, response, url, distDir) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', '静态页面只支持 GET 和 HEAD');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new ApiError(400, 'BAD_PATH', '请求路径编码无效');
  }
  if (pathname.includes('\0')) {
    throw new ApiError(400, 'BAD_PATH', '请求路径无效');
  }
  const normalizedDist = path.resolve(distDir);
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  let filePath = path.resolve(normalizedDist, relativePath);
  const insideDist = filePath === normalizedDist || filePath.startsWith(`${normalizedDist}${path.sep}`);
  if (!insideDist) {
    throw new ApiError(403, 'BAD_PATH', '请求路径超出静态目录');
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
  } catch {
    const acceptsHtml = (request.headers.accept ?? '').includes('text/html');
    if (!acceptsHtml || path.extname(relativePath)) {
      throw new ApiError(404, 'NOT_FOUND', '文件不存在');
    }
    filePath = path.join(normalizedDist, 'index.html');
    try {
      fileStat = await stat(filePath);
    } catch {
      throw new ApiError(503, 'APP_NOT_BUILT', '尚未生成网页文件，请先运行 npm run build');
    }
  }

  const extension = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME_TYPES.get(extension) ?? 'application/octet-stream',
    'Content-Length': fileStat.size,
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    response.on('close', resolve);
    stream.on('end', resolve);
    stream.pipe(response);
  });
}

function errorPayload(error) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      payload: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }
  const fileSystemErrors = {
    ENOSPC: [507, 'STORAGE_FULL', '磁盘空间已满，请清理空间后重试'],
    EDQUOT: [507, 'STORAGE_FULL', '磁盘配额已用尽，请清理空间后重试'],
    EIO: [500, 'STORAGE_IO_ERROR', '磁盘读写失败，请检查存储设备后重试'],
    EACCES: [403, 'STORAGE_PERMISSION_DENIED', '当前账号无权写入数据目录，请检查目录权限'],
    EPERM: [403, 'STORAGE_PERMISSION_DENIED', '数据目录拒绝写入，请检查目录权限'],
    EROFS: [403, 'STORAGE_READ_ONLY', '数据所在磁盘为只读，请更换可写位置'],
    EBUSY: [409, 'STORAGE_BUSY', '数据文件正被其他程序占用，请关闭占用程序后重试'],
    ETXTBSY: [409, 'STORAGE_BUSY', '数据文件正被其他程序占用，请关闭占用程序后重试'],
  };
  const mapped = fileSystemErrors[error?.code];
  if (mapped) {
    return {
      status: mapped[0],
      payload: { error: { code: mapped[1], message: mapped[2] } },
    };
  }
  console.error('[记工本] 未处理的服务错误：', error);
  return {
    status: 500,
    payload: { error: { code: 'INTERNAL_ERROR', message: '本机服务发生错误，请稍后重试' } },
  };
}

export async function createApp(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const dataDir = path.resolve(
    options.dataDir ?? process.env.JIGONGBEN_DATA_DIR ?? path.join(rootDir, 'data'),
  );
  const distDir = path.resolve(options.distDir ?? path.join(rootDir, 'dist'));
  const sessionToken = options.sessionToken ?? null;
  if (
    sessionToken !== null &&
    (typeof sessionToken !== 'string' || sessionToken.length < 32 || sessionToken.length > 256)
  ) {
    throw new TypeError('桌面会话密钥格式无效');
  }
  const store = options.store ?? new DataStore({
    rootDir,
    dataDir,
    now: options.now,
    acquireLock: options.acquireLock,
    maxDailyBackups: options.maxDailyBackups,
    maxPreRestoreBackups: options.maxPreRestoreBackups,
    maxDataBytes: options.maxDataBytes,
  });
  if (!options.store) {
    try {
      await store.init();
    } catch (error) {
      await store.close().catch(() => {});
      throw error;
    }
  }

  const app = (request, response) => {
    applySecurityHeaders(response);
    Promise.resolve()
      .then(async () => {
        const host = assertLocalRequest(request);
        const url = new URL(request.url ?? '/', `http://${host.host}`);
        if (url.pathname.startsWith('/api/')) {
          assertApiSession(request, sessionToken);
          await handleApi(request, response, url, store, host);
        } else {
          await serveStatic(request, response, url, distDir);
        }
      })
      .catch((error) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        const result = errorPayload(error);
        sendJson(response, result.status, result.payload);
      });
  };
  app.store = store;
  app.ownsStore = !options.store;
  app.rootDir = rootDir;
  app.distDir = distDir;
  return app;
}

async function probeExistingApp(host, port, expectedDataDirFingerprint, sessionToken = null) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: host,
        port,
        path: '/api/health',
        timeout: 700,
        ...(sessionToken ? { headers: { Authorization: `Bearer ${sessionToken}` } } : {}),
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(
              body?.app === 'jigongben-local' &&
              body?.dataDirFingerprint === expectedDataDirFingerprint,
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('为保护本地数据，服务只能监听回环地址');
  }
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const dataDir = path.resolve(
    options.dataDir ?? process.env.JIGONGBEN_DATA_DIR ?? path.join(rootDir, 'data'),
  );
  const expectedDataDirFingerprint = fingerprintDataDir(dataDir);
  const firstPort = options.port ?? 8765;
  const lastPort = options.endPort ?? firstPort;
  if (
    !Number.isInteger(firstPort) ||
    !Number.isInteger(lastPort) ||
    firstPort < 0 ||
    lastPort < firstPort ||
    lastPort > 65535
  ) {
    throw new Error('端口范围无效');
  }

  if (firstPort !== 0 && options.reuseExisting !== false) {
    for (let port = firstPort; port <= lastPort; port += 1) {
      if (await probeExistingApp(host, port, expectedDataDirFingerprint, options.sessionToken ?? null)) {
        return { server: null, app: null, reused: true, host, port, url: `http://${host}:${port}` };
      }
    }
  }

  const app = await createApp(options);
  for (let requestedPort = firstPort; requestedPort <= lastPort; requestedPort += 1) {
    const server = http.createServer(app);
    try {
      await listen(server, requestedPort, host);
      if (app.ownsStore) {
        server.once('close', () => {
          app.store.close().catch(() => {});
        });
      }
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : requestedPort;
      return { server, app, reused: false, host, port, url: `http://${host}:${port}` };
    } catch (error) {
      server.close();
      if (error?.code !== 'EADDRINUSE' || requestedPort === lastPort) {
        if (app.ownsStore) await app.store.close().catch(() => {});
        throw error;
      }
    }
  }
  if (app.ownsStore) await app.store.close().catch(() => {});
  throw new Error('没有可用端口');
}
