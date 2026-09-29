export const SCHEMA_VERSION = 8;
export const ATTENDANCE_STATUSES = new Set(['present', 'absent', null]);
export const OVERTIME_STATUSES = new Set(['half', 'full', null]);
export const LEAVE_PAY_TYPES = new Set(['paid', 'unpaid']);
export const WEEK_START_VALUES = new Set([0, 1, 6]);
export const THEME_VALUES = new Set(['light', 'dark']);
export const PAY_ADJUSTMENT_KINDS = new Set(['allowance', 'deduction']);

const NAME_PATTERN = /^[\p{L}\p{N}·•._\-（）() ]+$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const MAX_RATE_FEN = 100_000_000;
const MAX_OVERTIME_PAY_PERCENT = 1_000;
const MAX_NOTE_LENGTH = 10_000;
const MAX_DAY_NOTE_LENGTH = 1_000;
const MAX_LABEL_LENGTH = 100;
const MAX_ID_LENGTH = 100;
const MAX_AVATAR_BYTES = 512 * 1024;
const AVATAR_DATA_URL_PATTERN = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;
const EMOJI_GRAPHEME_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const REGIONAL_FLAG_PATTERN = /^(?:\p{Regional_Indicator}){2}$/u;
const KEYCAP_EMOJI_PATTERN = /^[#*0-9]\uFE0F?\u20E3$/u;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(value, label = '请求内容') {
  if (!isPlainObject(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须是 JSON 对象`);
  }
  return value;
}

export function assertAllowedKeys(value, allowedKeys, label = '请求内容') {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}包含未知字段`, { fields: unknown });
  }
}

export function assertId(value, label = 'ID') {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ID_LENGTH) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}无效`);
  }
  return value;
}

export function normalizeName(value) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', '工人姓名必须是文字');
  }
  const name = value.trim().replace(/\s+/gu, ' ');
  const length = [...name].length;
  if (length < 1 || length > 50 || !NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '工人姓名应为 1 至 50 个汉字、字母、数字或常用连接符');
  }
  return name;
}

export function normalizeLabel(value, label = '名称') {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须是文字`);
  }
  const normalized = value.trim().replace(/\s+/gu, ' ');
  const length = [...normalized].length;
  if (length < 1 || length > MAX_LABEL_LENGTH) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}应为 1 至 ${MAX_LABEL_LENGTH} 个字符`);
  }
  return normalized;
}

export function normalizeNote(value, label = '备注') {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须是文字`);
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}不能超过 ${MAX_NOTE_LENGTH} 个字符`);
  }
  return value;
}

export function normalizeDayNote(value) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', '单日备注必须是文字');
  }
  if (value.length > MAX_DAY_NOTE_LENGTH) {
    throw new ApiError(400, 'VALIDATION_ERROR', `单日备注不能超过 ${MAX_DAY_NOTE_LENGTH} 个字符`);
  }
  return value;
}

export function normalizeAvatarDataUrl(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', '工人头像必须是图片数据或 null');
  }
  const match = AVATAR_DATA_URL_PATTERN.exec(value);
  if (!match || match[2].length % 4 !== 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', '工人头像只支持 JPEG、PNG 或 WebP 图片');
  }
  const encoded = match[2];
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const byteLength = (encoded.length * 3) / 4 - padding;
  if (byteLength <= 0 || byteLength > MAX_AVATAR_BYTES) {
    throw new ApiError(400, 'VALIDATION_ERROR', '处理后的工人头像不能超过 512KB');
  }
  return `data:image/${match[1].toLowerCase()};base64,${encoded}`;
}

export function normalizeAvatarEmoji(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Emoji 头像必须是单个 emoji 或 null');
  }
  const graphemes = [...EMOJI_GRAPHEME_SEGMENTER.segment(value)];
  const isEmoji =
    EXTENDED_PICTOGRAPHIC_PATTERN.test(value) ||
    REGIONAL_FLAG_PATTERN.test(value) ||
    KEYCAP_EMOJI_PATTERN.test(value);
  if (graphemes.length !== 1 || graphemes[0]?.segment !== value || !isEmoji) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Emoji 头像必须是单个可见 emoji');
  }
  return value;
}

export function assertRateFen(value, label = '金额') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RATE_FEN) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须是 0 至 ${MAX_RATE_FEN} 之间、以分为单位的整数`);
  }
  return value;
}

export function assertPositiveAmountFen(value, label = '金额') {
  assertRateFen(value, label);
  if (value === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须大于 0`);
  }
  return value;
}

export function assertOvertimePayPercent(value, label = '加班倍率') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OVERTIME_PAY_PERCENT) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `${label}必须是 0 至 ${MAX_OVERTIME_PAY_PERCENT} 之间的整数百分比`,
    );
  }
  return value;
}

export function assertIsoMonth(value, label = '月份') {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须使用 YYYY-MM 格式`);
  }
  const match = MONTH_PATTERN.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}不是有效月份`);
  }
  return value;
}

export function assertIsoDate(value, label = '日期') {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须使用 YYYY-MM-DD 格式`);
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须使用 YYYY-MM-DD 格式`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}不是有效日期`);
  }
  return value;
}

export function assertTimestamp(value, label = '时间') {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}必须是有效的 ISO 时间`);
  }
  return value;
}

export function assertNullableTimestamp(value, label = '时间') {
  if (value !== null) assertTimestamp(value, label);
  return value;
}

export function assertStatus(value) {
  if (!ATTENDANCE_STATUSES.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '考勤状态只能是 present、absent 或 null');
  }
  return value;
}

export function assertOvertimeStatus(value) {
  if (!OVERTIME_STATUSES.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '加班状态只能是 half、full 或 null');
  }
  return value;
}

export function normalizeLeave(value, { overtime = false, label = '请假' } = {}) {
  if (value === null) return null;
  const input = assertPlainObject(value, label);
  assertAllowedKeys(input, overtime ? ['payType', 'units'] : ['payType'], label);
  if (!LEAVE_PAY_TYPES.has(input.payType)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label} payType 只能是 paid 或 unpaid`);
  }
  if (!overtime) return { payType: input.payType };
  if (input.payType === 'unpaid') {
    if (Object.hasOwn(input, 'units')) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${label}为无薪时不能设置 units`);
    }
    return { payType: 'unpaid' };
  }
  if (input.units !== 'half' && input.units !== 'full') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label}为带薪时 units 只能是 half 或 full`);
  }
  return { payType: 'paid', units: input.units };
}

export function assertWeekStartsOn(value) {
  if (!WEEK_START_VALUES.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '每周起始日只能是 0（周日）、1（周一）或 6（周六）');
  }
  return value;
}

export function assertTheme(value) {
  if (!THEME_VALUES.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '主题只能是 light 或 dark');
  }
  return value;
}

export function assertPayAdjustmentKind(value) {
  if (!PAY_ADJUSTMENT_KINDS.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '补贴扣款类型只能是 allowance 或 deduction');
  }
  return value;
}

function backupError(message, details) {
  throw new ApiError(400, 'INVALID_BACKUP', message, details);
}

function validateWorker(worker, seenIds) {
  assertPlainObject(worker, '工人记录');
  assertAllowedKeys(
    worker,
    [
      'id', 'name', 'avatarDataUrl', 'avatarEmoji', 'defaultDailyRateFen', 'note',
      'defaultSiteId', 'createdAt', 'archivedAt',
    ],
    '工人记录',
  );
  try {
    assertId(worker.id, '工人 ID');
  } catch {
    backupError('工人 ID 无效');
  }
  if (seenIds.has(worker.id)) backupError('备份中存在重复的工人 ID');
  seenIds.add(worker.id);
  worker.name = normalizeName(worker.name);
  worker.avatarDataUrl = normalizeAvatarDataUrl(worker.avatarDataUrl);
  worker.avatarEmoji = normalizeAvatarEmoji(worker.avatarEmoji);
  if (worker.avatarDataUrl !== null && worker.avatarEmoji !== null) {
    backupError('工人图片头像和 Emoji 头像不能同时存在');
  }
  assertRateFen(worker.defaultDailyRateFen, '默认日薪');
  worker.note = normalizeNote(worker.note, '工人备注');
  if (worker.defaultSiteId !== null) assertId(worker.defaultSiteId, '默认工地 ID');
  assertTimestamp(worker.createdAt, '工人创建时间');
  assertNullableTimestamp(worker.archivedAt, '工人归档时间');
}

function validateSite(site, seenIds) {
  assertPlainObject(site, '工地记录');
  assertAllowedKeys(site, ['id', 'name', 'note', 'createdAt', 'archivedAt'], '工地记录');
  assertId(site.id, '工地 ID');
  if (seenIds.has(site.id)) backupError('备份中存在重复的工地 ID');
  seenIds.add(site.id);
  site.name = normalizeLabel(site.name, '工地名称');
  site.note = normalizeNote(site.note, '工地备注');
  assertTimestamp(site.createdAt, '工地创建时间');
  assertNullableTimestamp(site.archivedAt, '工地归档时间');
}

function validateAttendance(entry, workerIds, siteIds, seenKeys) {
  assertPlainObject(entry, '考勤记录');
  assertAllowedKeys(
    entry,
    [
      'workerId', 'date', 'morning', 'afternoon', 'overtime', 'dayNote',
      'morningSiteId', 'afternoonSiteId', 'overtimeSiteId',
      'morningLeave', 'afternoonLeave', 'overtimeLeave',
    ],
    '考勤记录',
  );
  if (!workerIds.has(entry.workerId)) backupError('考勤记录引用了不存在的工人');
  assertIsoDate(entry.date);
  assertStatus(entry.morning);
  assertStatus(entry.afternoon);
  assertOvertimeStatus(entry.overtime);
  entry.morningLeave = normalizeLeave(entry.morningLeave, { label: '上午请假' });
  entry.afternoonLeave = normalizeLeave(entry.afternoonLeave, { label: '下午请假' });
  entry.overtimeLeave = normalizeLeave(entry.overtimeLeave, { overtime: true, label: '加班请假' });
  entry.dayNote = normalizeDayNote(entry.dayNote);
  for (const [statusKey, siteKey, leaveKey] of [
    ['morning', 'morningSiteId', 'morningLeave'],
    ['afternoon', 'afternoonSiteId', 'afternoonLeave'],
    ['overtime', 'overtimeSiteId', 'overtimeLeave'],
  ]) {
    if (entry[leaveKey] !== null && (entry[statusKey] !== null || entry[siteKey] !== null)) {
      backupError('请假时不能同时保留出工状态或工地');
    }
  }
  for (const [siteKey, statusKey, activeValues] of [
    ['morningSiteId', 'morning', new Set(['present'])],
    ['afternoonSiteId', 'afternoon', new Set(['present'])],
    ['overtimeSiteId', 'overtime', new Set(['half', 'full'])],
  ]) {
    const siteId = entry[siteKey];
    if (siteId !== null) {
      if (!siteIds.has(siteId)) backupError('考勤记录引用了不存在的工地');
      if (!activeValues.has(entry[statusKey])) backupError('未出工时不能保留工地引用');
    }
  }
  if (
    entry.morning === null && entry.afternoon === null && entry.overtime === null &&
    entry.dayNote === '' && entry.morningSiteId === null &&
    entry.afternoonSiteId === null && entry.overtimeSiteId === null &&
    entry.morningLeave === null && entry.afternoonLeave === null && entry.overtimeLeave === null
  ) {
    backupError('备份中不能包含完全空白的考勤记录');
  }
  const key = `${entry.workerId}\u0000${entry.date}`;
  if (seenKeys.has(key)) backupError('备份中存在重复的考勤日期');
  seenKeys.add(key);
}

function validateMonthlyRecord(record, workerIds, seenKeys) {
  assertPlainObject(record, '月度记录');
  assertAllowedKeys(
    record,
    ['workerId', 'month', 'dailyRateFen', 'overtimePayPercent', 'note', 'paidAt'],
    '月度记录',
  );
  if (!workerIds.has(record.workerId)) backupError('月度记录引用了不存在的工人');
  assertIsoMonth(record.month);
  assertRateFen(record.dailyRateFen, '月度日薪');
  assertOvertimePayPercent(record.overtimePayPercent, '月度加班倍率');
  record.note = normalizeNote(record.note, '月度备注');
  assertNullableTimestamp(record.paidAt, '结清时间');
  const key = `${record.workerId}\u0000${record.month}`;
  if (seenKeys.has(key)) backupError('备份中存在重复的月度记录');
  seenKeys.add(key);
}

function validatePayAdjustment(adjustment, workerIds, siteIds, seenIds) {
  assertPlainObject(adjustment, '补贴扣款记录');
  assertAllowedKeys(
    adjustment,
    ['id', 'workerId', 'month', 'date', 'kind', 'amountFen', 'label', 'note', 'siteId', 'createdAt', 'updatedAt'],
    '补贴扣款记录',
  );
  assertId(adjustment.id, '补贴扣款 ID');
  if (seenIds.has(adjustment.id)) backupError('备份中存在重复的补贴扣款 ID');
  seenIds.add(adjustment.id);
  if (!workerIds.has(adjustment.workerId)) backupError('补贴扣款引用了不存在的工人');
  if (adjustment.siteId !== null) {
    assertId(adjustment.siteId, '补贴扣款工地 ID');
    if (!siteIds.has(adjustment.siteId)) backupError('补贴扣款引用了不存在的工地');
  }
  assertIsoMonth(adjustment.month);
  if (adjustment.date !== null) {
    assertIsoDate(adjustment.date);
    if (adjustment.date.slice(0, 7) !== adjustment.month) backupError('补贴扣款日期必须属于所选月份');
  }
  assertPayAdjustmentKind(adjustment.kind);
  assertPositiveAmountFen(adjustment.amountFen, '补贴扣款金额');
  adjustment.label = normalizeLabel(adjustment.label, '补贴扣款项目');
  adjustment.note = normalizeNote(adjustment.note, '补贴扣款备注');
  assertTimestamp(adjustment.createdAt, '补贴扣款创建时间');
  assertTimestamp(adjustment.updatedAt, '补贴扣款更新时间');
  if (Date.parse(adjustment.updatedAt) < Date.parse(adjustment.createdAt)) {
    backupError('补贴扣款更新时间不能早于创建时间');
  }
}

function migrateAppData(input, options = {}) {
  const source = assertPlainObject(input, '备份');
  const data = options.cloneInput === false ? source : structuredClone(source);
  if (Number.isSafeInteger(data.schemaVersion) && data.schemaVersion > SCHEMA_VERSION) {
    throw new ApiError(400, 'UNSUPPORTED_SCHEMA', `仅支持版本 1 至 ${SCHEMA_VERSION} 的备份`, {
      received: data.schemaVersion,
    });
  }
  if (!Number.isSafeInteger(data.schemaVersion) || data.schemaVersion < 1) {
    backupError('备份 schemaVersion 无效');
  }
  const originalSchemaVersion = data.schemaVersion;

  if (data.schemaVersion === 1) {
    if (Array.isArray(data.workers)) {
      for (const worker of data.workers) {
        if (isPlainObject(worker)) worker.avatarDataUrl = null;
      }
    }
    if (Array.isArray(data.attendance)) {
      for (const entry of data.attendance) {
        if (isPlainObject(entry)) entry.overtime = null;
      }
    }
    data.schemaVersion = 2;
  }

  if (data.schemaVersion === 2) {
    if (Array.isArray(data.attendance)) {
      for (const entry of data.attendance) {
        if (isPlainObject(entry)) entry.dayNote = '';
      }
    }
    if (isPlainObject(data.settings)) {
      data.settings.theme = 'light';
      data.settings.sidebarCollapsed = false;
      data.settings.lastBackupExportAt = null;
      data.settings.lastBackupReminderAt = null;
    }
    data.schemaVersion = 3;
  }

  if (data.schemaVersion === 3) {
    data.payAdjustments = [];
    data.schemaVersion = 4;
  }

  if (data.schemaVersion === 4) {
    data.sites = [];
    if (Array.isArray(data.workers)) {
      for (const worker of data.workers) {
        if (isPlainObject(worker)) worker.defaultSiteId = null;
      }
    }
    if (Array.isArray(data.attendance)) {
      for (const entry of data.attendance) {
        if (!isPlainObject(entry)) continue;
        entry.morningSiteId = null;
        entry.afternoonSiteId = null;
        entry.overtimeSiteId = null;
      }
    }
    data.schemaVersion = 5;
  }

  if (data.schemaVersion === 5) {
    if (Array.isArray(data.workers)) {
      for (const worker of data.workers) {
        if (isPlainObject(worker)) worker.avatarEmoji = null;
      }
    }
    if (Array.isArray(data.monthlyRecords)) {
      for (const record of data.monthlyRecords) {
        if (isPlainObject(record)) record.paidAt = null;
      }
    }
    if (isPlainObject(data.settings)) {
      data.settings.weeklyAutoBackupEnabled = true;
      data.settings.lastWeeklyBackupAt = null;
    }
    data.schemaVersion = 6;
  }
  if (data.schemaVersion === 6) {
    if (Array.isArray(data.monthlyRecords)) {
      for (const record of data.monthlyRecords) {
        if (isPlainObject(record)) record.overtimePayPercent = 100;
      }
    }
    if (isPlainObject(data.settings)) {
      data.settings.defaultOvertimePayPercent = 100;
    }
    data.schemaVersion = 7;
  }
  if (data.schemaVersion === 7) {
    if (Array.isArray(data.attendance)) {
      for (const entry of data.attendance) {
        if (!isPlainObject(entry)) continue;
        entry.morningLeave = null;
        entry.afternoonLeave = null;
        entry.overtimeLeave = null;
      }
    }
    if (Array.isArray(data.payAdjustments)) {
      for (const adjustment of data.payAdjustments) {
        if (isPlainObject(adjustment)) adjustment.siteId = null;
      }
    }
    data.operationReceipts = [];
    data.schemaVersion = 8;
  }
  if (originalSchemaVersion < SCHEMA_VERSION && Array.isArray(data.attendance)) {
    data.attendance = data.attendance.filter(
      (entry) =>
        !isPlainObject(entry) ||
        entry.morning !== null || entry.afternoon !== null || entry.overtime !== null ||
        entry.dayNote !== '' || entry.morningSiteId !== null ||
        entry.afternoonSiteId !== null || entry.overtimeSiteId !== null ||
        entry.morningLeave !== null || entry.afternoonLeave !== null || entry.overtimeLeave !== null,
    );
  }
  return data;
}

export function validateAppData(input, options = {}) {
  const data = migrateAppData(input, options);
  assertAllowedKeys(
    data,
    [
      'schemaVersion', 'revision', 'workers', 'attendance', 'monthlyRecords', 'payAdjustments',
      'sites', 'settings', 'operationReceipts',
    ],
    '备份',
  );
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new ApiError(400, 'UNSUPPORTED_SCHEMA', `仅支持版本 ${SCHEMA_VERSION} 的备份`, {
      received: data.schemaVersion,
    });
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) backupError('备份 revision 无效');
  if (
    !Array.isArray(data.workers) || !Array.isArray(data.attendance) ||
    !Array.isArray(data.monthlyRecords) || !Array.isArray(data.payAdjustments) || !Array.isArray(data.sites)
  ) {
    backupError('备份中的工人、考勤、月度记录、补贴扣款和工地必须是数组');
  }

  const siteIds = new Set();
  for (const site of data.sites) validateSite(site, siteIds);

  const workerIds = new Set();
  for (const worker of data.workers) validateWorker(worker, workerIds);
  for (const worker of data.workers) {
    if (worker.defaultSiteId !== null) {
      const site = data.sites.find((candidate) => candidate.id === worker.defaultSiteId);
      if (!site) backupError('工人的默认工地不存在');
      if (site.archivedAt !== null) backupError('工人的默认工地不能是已归档工地');
    }
  }

  const attendanceKeys = new Set();
  for (const entry of data.attendance) validateAttendance(entry, workerIds, siteIds, attendanceKeys);
  const monthlyKeys = new Set();
  for (const record of data.monthlyRecords) validateMonthlyRecord(record, workerIds, monthlyKeys);
  const adjustmentIds = new Set();
  for (const adjustment of data.payAdjustments) {
    validatePayAdjustment(adjustment, workerIds, siteIds, adjustmentIds);
  }

  if (!Array.isArray(data.operationReceipts) || data.operationReceipts.length > 2048) {
    backupError('幂等操作回执必须是不超过 2048 项的数组');
  }
  const operationIds = new Set();
  for (const receipt of data.operationReceipts) {
    assertPlainObject(receipt, '幂等操作回执');
    assertAllowedKeys(receipt, ['operationId', 'requestHash', 'committedRevision'], '幂等操作回执');
    if (
      typeof receipt.operationId !== 'string' || receipt.operationId.length < 1 ||
      receipt.operationId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(receipt.operationId)
    ) {
      backupError('幂等操作 operationId 无效');
    }
    if (operationIds.has(receipt.operationId)) backupError('幂等操作 operationId 重复');
    operationIds.add(receipt.operationId);
    if (typeof receipt.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.requestHash)) {
      backupError('幂等操作 requestHash 无效');
    }
    if (
      !Number.isSafeInteger(receipt.committedRevision) || receipt.committedRevision < 0 ||
      receipt.committedRevision > data.revision
    ) {
      backupError('幂等操作 committedRevision 无效');
    }
  }

  assertPlainObject(data.settings, '设置');
  assertAllowedKeys(
    data.settings,
    [
      'weekStartsOn', 'currentWorkerId', 'theme', 'sidebarCollapsed',
      'lastBackupExportAt', 'lastBackupReminderAt',
      'weeklyAutoBackupEnabled', 'lastWeeklyBackupAt', 'defaultOvertimePayPercent',
    ],
    '设置',
  );
  assertWeekStartsOn(data.settings.weekStartsOn);
  assertTheme(data.settings.theme);
  if (typeof data.settings.sidebarCollapsed !== 'boolean') backupError('侧边栏折叠设置无效');
  if (typeof data.settings.weeklyAutoBackupEnabled !== 'boolean') backupError('每周自动备份设置无效');
  assertOvertimePayPercent(data.settings.defaultOvertimePayPercent, '默认加班倍率');
  assertNullableTimestamp(data.settings.lastBackupExportAt, '上次导出时间');
  assertNullableTimestamp(data.settings.lastBackupReminderAt, '上次备份提醒时间');
  assertNullableTimestamp(data.settings.lastWeeklyBackupAt, '上次每周备份时间');
  if (data.settings.currentWorkerId !== null) {
    if (typeof data.settings.currentWorkerId !== 'string' || !workerIds.has(data.settings.currentWorkerId)) {
      backupError('当前工人 ID 无效');
    }
    const current = data.workers.find((worker) => worker.id === data.settings.currentWorkerId);
    if (current.archivedAt !== null) backupError('当前工人不能是已归档工人');
  }
  return data;
}

export function emptyAppData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    workers: [],
    attendance: [],
    monthlyRecords: [],
    payAdjustments: [],
    sites: [],
    operationReceipts: [],
    settings: {
      weekStartsOn: 1,
      currentWorkerId: null,
      theme: 'light',
      sidebarCollapsed: false,
      lastBackupExportAt: null,
      lastBackupReminderAt: null,
      weeklyAutoBackupEnabled: true,
      lastWeeklyBackupAt: null,
      defaultOvertimePayPercent: 100,
    },
  };
}
