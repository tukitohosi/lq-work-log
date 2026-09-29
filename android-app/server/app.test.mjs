// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as nodeHttpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MAX_JSON_BYTES, startServer } from './app.mjs';
import { MAX_DATA_BYTES, appDataSizeBytes } from './store.mjs';
import { emptyAppData, validateAppData } from './validation.mjs';

const cleanups = [];
const TEST_AVATAR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()();
  }
});

async function startFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jigongben-server-'));
  const dataDir = path.join(root, 'data');
  const distDir = path.join(root, 'dist');
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>记工本</title>', 'utf8');
  if (options.records !== undefined) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, 'records.json'),
      typeof options.records === 'string' ? options.records : JSON.stringify(options.records),
      'utf8',
    );
  }
  if (options.internalBackups) {
    const backupsDir = path.join(dataDir, 'backups');
    await mkdir(backupsDir, { recursive: true });
    for (const backup of options.internalBackups) {
      await writeFile(
        path.join(backupsDir, backup.name),
        typeof backup.data === 'string' ? backup.data : JSON.stringify(backup.data),
        'utf8',
      );
    }
  }
  const running = await startServer({
    port: 0,
    endPort: 0,
    reuseExisting: false,
    rootDir: root,
    dataDir,
    distDir,
    now: options.now ?? (() => new Date('2026-12-31T12:00:00.000Z')),
    sessionToken: options.sessionToken,
    maxDataBytes: options.maxDataBytes,
  });
  cleanups.push(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { ...running, root, dataDir };
}

async function api(running, pathname, init = {}) {
  const response = await fetch(`${running.url}${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const data = await response.json();
  return { response, data };
}

async function rawApi(running, pathname, options = {}) {
  const target = new URL(running.url);
  const body = options.body ?? '';
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      method: options.method ?? 'GET',
      headers: {
        Host: options.host ?? target.host,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...options.headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: response.statusCode, headers: response.headers, data });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function sendMutationAndDropResponse(running, pathname, body, operationId) {
  const target = new URL(running.url);
  await new Promise((resolve, reject) => {
    const request = nodeHttpRequest({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      method: 'POST',
      headers: {
        Host: target.host,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-LQ-Operation-Id': operationId,
      },
    }, (response) => {
      response.destroy();
      resolve();
    });
    request.on('error', (error) => {
      if (error?.code === 'ECONNRESET') resolve();
      else reject(error);
    });
    request.end(body);
  });
}

describe('本机记工服务', () => {
  it('将 v1 至 v7 数据逐级迁移并验证为 v8', () => {
    const base = {
      revision: 2,
      workers: [{
        id: 'worker',
        name: '迁移工人',
        avatarDataUrl: null,
        avatarEmoji: null,
        defaultDailyRateFen: 30_000,
        note: '',
        defaultSiteId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        archivedAt: null,
      }],
      attendance: [{
        workerId: 'worker',
        date: '2026-01-01',
        morning: 'present',
        afternoon: null,
        overtime: null,
        dayNote: '开工',
        morningSiteId: null,
        afternoonSiteId: null,
        overtimeSiteId: null,
      }],
      monthlyRecords: [{
        workerId: 'worker',
        month: '2026-01',
        dailyRateFen: 30_000,
        overtimePayPercent: 175,
        note: '',
        paidAt: null,
      }],
      payAdjustments: [],
      sites: [],
      settings: {
        weekStartsOn: 6,
        currentWorkerId: 'worker',
        theme: 'light',
        sidebarCollapsed: false,
        lastBackupExportAt: null,
        lastBackupReminderAt: null,
        weeklyAutoBackupEnabled: true,
        lastWeeklyBackupAt: null,
        defaultOvertimePayPercent: 150,
      },
    };
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      const candidate = structuredClone({ schemaVersion: version, ...base });
      if (version < 7) {
        delete candidate.monthlyRecords[0].overtimePayPercent;
        delete candidate.settings.defaultOvertimePayPercent;
      }
      if (version < 6) {
        delete candidate.workers[0].avatarEmoji;
        delete candidate.monthlyRecords[0].paidAt;
        delete candidate.settings.weeklyAutoBackupEnabled;
        delete candidate.settings.lastWeeklyBackupAt;
      }
      if (version < 5) {
        delete candidate.sites;
        delete candidate.workers[0].defaultSiteId;
        delete candidate.attendance[0].morningSiteId;
        delete candidate.attendance[0].afternoonSiteId;
        delete candidate.attendance[0].overtimeSiteId;
      }
      if (version < 4) delete candidate.payAdjustments;
      if (version < 3) {
        delete candidate.attendance[0].dayNote;
        delete candidate.settings.theme;
        delete candidate.settings.sidebarCollapsed;
        delete candidate.settings.lastBackupExportAt;
        delete candidate.settings.lastBackupReminderAt;
      }
      if (version < 2) {
        delete candidate.workers[0].avatarDataUrl;
        delete candidate.attendance[0].overtime;
      }
      const migrated = validateAppData(candidate);
      expect(migrated).toMatchObject({ schemaVersion: 8, revision: 2 });
      expect(migrated.workers[0]).toMatchObject({
        avatarDataUrl: null,
        avatarEmoji: null,
        defaultSiteId: null,
      });
      expect(migrated.monthlyRecords[0].paidAt).toBeNull();
      expect(migrated.monthlyRecords[0].overtimePayPercent).toBe(version < 7 ? 100 : 175);
      expect(migrated.attendance[0]).toMatchObject({
        overtime: null,
        dayNote: version < 3 ? '' : '开工',
        morningSiteId: null,
        morningLeave: null,
        afternoonLeave: null,
        overtimeLeave: null,
      });
      expect(migrated.settings).toMatchObject({
        theme: 'light',
        sidebarCollapsed: false,
        weeklyAutoBackupEnabled: true,
        lastWeeklyBackupAt: null,
        defaultOvertimePayPercent: version < 7 ? 100 : 150,
      });
      expect(migrated.payAdjustments).toEqual([]);
      expect(migrated.sites).toEqual([]);
      expect(migrated.operationReceipts).toEqual([]);
    }
  });

  it('拒绝未知未来版本和伪装成旧版本的未来字段', () => {
    expect(() => validateAppData({ ...emptyAppData(), schemaVersion: 9 })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA' }),
    );
    const forged = {
      schemaVersion: 4,
      revision: 0,
      workers: [],
      attendance: [],
      monthlyRecords: [],
      payAdjustments: [],
      sites: [{ id: 'hidden-future-field' }],
      settings: {
        weekStartsOn: 6,
        currentWorkerId: null,
        theme: 'light',
        sidebarCollapsed: false,
        lastBackupExportAt: null,
        lastBackupReminderAt: null,
      },
    };
    expect(validateAppData(forged).sites).toEqual([]);
  });

  it('将 v7 考勤与补贴扣款无损补齐为 v8 字段', () => {
    const legacy = emptyAppData();
    legacy.schemaVersion = 7;
    delete legacy.operationReceipts;
    legacy.sites.push({
      id: 'site-v7',
      name: '旧工地',
      note: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });
    legacy.workers.push({
      id: 'worker-v7',
      name: '旧工人',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 30_000,
      note: '',
      defaultSiteId: 'site-v7',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });
    legacy.attendance.push({
      workerId: 'worker-v7',
      date: '2026-01-01',
      morning: 'present',
      afternoon: null,
      overtime: null,
      dayNote: '',
      morningSiteId: 'site-v7',
      afternoonSiteId: null,
      overtimeSiteId: null,
    });
    legacy.payAdjustments.push({
      id: 'adjustment-v7',
      workerId: 'worker-v7',
      month: '2026-01',
      date: null,
      kind: 'allowance',
      amountFen: 100,
      label: '补贴',
      note: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const migrated = validateAppData(legacy);
    expect(migrated).toMatchObject({ schemaVersion: 8, operationReceipts: [] });
    expect(migrated.attendance[0]).toMatchObject({
      morningLeave: null,
      afternoonLeave: null,
      overtimeLeave: null,
    });
    expect(migrated.payAdjustments[0].siteId).toBeNull();
  });

  it('提供健康状态、静态页面并持久化新增工人', async () => {
    const running = await startFixture();
    const health = await api(running, '/api/health');
    expect(health.response.status).toBe(200);
    expect(health.data).toMatchObject({ ok: true, app: 'jigongben-local', revision: 0 });

    const page = await fetch(running.url);
    expect(await page.text()).toContain('记工本');

    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '李权', defaultDailyRateFen: 30_000, note: '' }),
    });
    expect(created.response.status).toBe(200);
    expect(created.data.revision).toBe(1);
    expect(created.data.workers[0]).toMatchObject({
      name: '李权',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 30_000,
    });
    expect(created.data.settings).toMatchObject({
      weekStartsOn: 1,
      currentWorkerId: created.data.workers[0].id,
      theme: 'light',
      sidebarCollapsed: false,
      lastBackupExportAt: null,
      lastBackupReminderAt: null,
      weeklyAutoBackupEnabled: true,
      lastWeeklyBackupAt: null,
      defaultOvertimePayPercent: 100,
    });

    const onDisk = JSON.parse(await readFile(path.join(running.dataDir, 'records.json'), 'utf8'));
    expect(onDisk).toEqual(created.data);
  });

  it('读取旧版数据时自动补齐头像和加班字段，并在下一次写入后保存为新版', async () => {
    const workerId = 'legacy-worker';
    const running = await startFixture({
      records: {
        schemaVersion: 1,
        revision: 7,
        workers: [
          {
            id: workerId,
            name: '旧记录工人',
            defaultDailyRateFen: 30_000,
            note: '',
            createdAt: '2026-07-01T00:00:00.000Z',
            archivedAt: null,
          },
        ],
        attendance: [
          { workerId, date: '2026-08-08', morning: 'present', afternoon: null },
        ],
        monthlyRecords: [],
        settings: { weekStartsOn: 6, currentWorkerId: workerId },
      },
    });

    const migrated = await api(running, '/api/state');
    expect(migrated.response.status).toBe(200);
    expect(migrated.data).toMatchObject({ schemaVersion: 8, revision: 7 });
    expect(migrated.data.workers[0].avatarDataUrl).toBeNull();
    expect(migrated.data.workers[0].avatarEmoji).toBeNull();
    expect(migrated.data.attendance[0].overtime).toBeNull();

    const updated = await api(running, '/api/attendance', {
      method: 'PUT',
      body: JSON.stringify({
        workerId,
        date: '2026-08-08',
        period: 'overtime',
        status: 'half',
      }),
    });
    expect(updated.response.status).toBe(200);
    expect(updated.data.attendance[0].overtime).toBe('half');
    const onDisk = JSON.parse(await readFile(path.join(running.dataDir, 'records.json'), 'utf8'));
    expect(onDisk).toMatchObject({ schemaVersion: 8, revision: 8 });
  });

  it('支持单个 emoji 头像，并始终保持图片头像与 emoji 互斥', async () => {
    const running = await startFixture();
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({
        name: '头像工人',
        avatarEmoji: '👨‍👩‍👧‍👦',
        defaultDailyRateFen: 30_000,
        note: '',
      }),
    });
    expect(created.response.status).toBe(200);
    const workerId = created.data.workers[0].id;
    expect(created.data.workers[0]).toMatchObject({ avatarDataUrl: null, avatarEmoji: '👨‍👩‍👧‍👦' });

    const pictured = await api(running, `/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ avatarDataUrl: TEST_AVATAR }),
    });
    expect(pictured.data.workers[0]).toMatchObject({ avatarDataUrl: TEST_AVATAR, avatarEmoji: null });

    const flagged = await api(running, `/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ avatarEmoji: '🇨🇳' }),
    });
    expect(flagged.data.workers[0]).toMatchObject({ avatarDataUrl: null, avatarEmoji: '🇨🇳' });

    for (const avatarEmoji of ['普通文字', '😀😀', '']) {
      const invalid = await api(running, `/api/workers/${workerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ avatarEmoji }),
      });
      expect(invalid.response.status).toBe(400);
      expect(invalid.data.error.code).toBe('VALIDATION_ERROR');
    }

    const conflicting = await api(running, `/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ avatarDataUrl: TEST_AVATAR, avatarEmoji: '😀' }),
    });
    expect(conflicting.response.status).toBe(400);
    expect((await api(running, '/api/state')).data.workers[0]).toMatchObject({
      avatarDataUrl: null,
      avatarEmoji: '🇨🇳',
    });
  });

  it('由服务端标记或取消月度结清，其他修改不会自动取消结清', async () => {
    let now = new Date('2026-08-14T03:04:05.000Z');
    const running = await startFixture({ now: () => now });
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '结清工人', defaultDailyRateFen: 30_000, note: '' }),
    });
    const workerId = created.data.workers[0].id;

    const paid = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-08', paid: true }),
    });
    expect(paid.response.status).toBe(200);
    expect(paid.data.monthlyRecords[0].paidAt).toBe('2026-08-14T03:04:05.000Z');

    now = new Date('2026-08-15T03:04:05.000Z');
    const edited = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-08', paid: true, note: '结清后补充说明' }),
    });
    expect(edited.data.monthlyRecords[0]).toMatchObject({
      note: '结清后补充说明',
      paidAt: '2026-08-14T03:04:05.000Z',
    });

    const forgedTimestamp = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-08', paidAt: now.toISOString() }),
    });
    expect(forgedTimestamp.response.status).toBe(400);

    const unpaid = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-08', paid: false }),
    });
    expect(unpaid.data.monthlyRecords[0].paidAt).toBeNull();
  });

  it('校验并保存每周自动备份设置', async () => {
    const running = await startFixture();
    const updated = await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ weeklyAutoBackupEnabled: false }),
    });
    expect(updated.response.status).toBe(200);
    expect(updated.data.settings).toMatchObject({
      weeklyAutoBackupEnabled: false,
      lastWeeklyBackupAt: null,
    });

    const forgedBackupTime = await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ lastWeeklyBackupAt: '2026-08-14T03:04:05.000Z' }),
    });
    expect(forgedBackupTime.response.status).toBe(400);

    const invalid = await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ weeklyAutoBackupEnabled: 'yes' }),
    });
    expect(invalid.response.status).toBe(400);
    expect((await api(running, '/api/state')).data.settings.weeklyAutoBackupEnabled).toBe(false);
  });

  it('校验默认与月度加班倍率，并在创建新月份时复制当前默认值', async () => {
    const running = await startFixture();
    const configured = await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultOvertimePayPercent: 150 }),
    });
    expect(configured.response.status).toBe(200);
    expect(configured.data.settings.defaultOvertimePayPercent).toBe(150);

    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '倍率工人', defaultDailyRateFen: 30_000, note: '' }),
    });
    const workerId = created.data.workers[0].id;
    const august = await api(running, '/api/attendance', {
      method: 'PUT',
      body: JSON.stringify({ workerId, date: '2026-08-08', period: 'overtime', status: 'half' }),
    });
    expect(august.data.monthlyRecords[0]).toMatchObject({
      month: '2026-08',
      overtimePayPercent: 150,
    });

    await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultOvertimePayPercent: 200 }),
    });
    const september = await api(running, '/api/attendance', {
      method: 'PUT',
      body: JSON.stringify({ workerId, date: '2026-09-08', period: 'overtime', status: 'full' }),
    });
    expect(september.data.monthlyRecords.find((record) => record.month === '2026-08').overtimePayPercent).toBe(150);
    expect(september.data.monthlyRecords.find((record) => record.month === '2026-09').overtimePayPercent).toBe(200);

    const overridden = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-09', overtimePayPercent: 175 }),
    });
    expect(overridden.data.monthlyRecords.find((record) => record.month === '2026-09').overtimePayPercent).toBe(175);

    const invalid = await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultOvertimePayPercent: 1_001 }),
    });
    expect(invalid.response.status).toBe(400);

    const zero = await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultOvertimePayPercent: 0 }),
    });
    expect(zero.data.settings.defaultOvertimePayPercent).toBe(0);
    const maximum = await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultOvertimePayPercent: 1_000 }),
    });
    expect(maximum.data.settings.defaultOvertimePayPercent).toBe(1_000);
    expect((await api(running, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultOvertimePayPercent: 150.5 }),
    })).response.status).toBe(400);
    expect((await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-09', overtimePayPercent: -1 }),
    })).response.status).toBe(400);
  });

  it('串行合并并发的上午和下午写入，并锁定继承的月度日薪', async () => {
    const running = await startFixture();
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '王强', defaultDailyRateFen: 30_000, note: '' }),
    });
    const workerId = created.data.workers[0].id;
    const payload = (period, status, date = '2026-08-08') => ({
      method: 'PUT',
      body: JSON.stringify({ workerId, date, period, status }),
    });

    await Promise.all([
      api(running, '/api/attendance', payload('morning', 'present')),
      api(running, '/api/attendance', payload('afternoon', 'absent')),
    ]);
    let state = (await api(running, '/api/state')).data;
    expect(state.attendance[0]).toMatchObject({ morning: 'present', afternoon: 'absent' });
    expect(state.monthlyRecords[0]).toMatchObject({ month: '2026-08', dailyRateFen: 30_000 });

    await api(running, `/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ defaultDailyRateFen: 40_000 }),
    });
    await api(running, '/api/attendance', payload('morning', 'present', '2026-09-01'));
    state = (await api(running, '/api/state')).data;
    expect(state.monthlyRecords.find((record) => record.month === '2026-09').dailyRateFen).toBe(30_000);

    await api(running, '/api/attendance', payload('morning', 'present', '2026-07-31'));
    state = (await api(running, '/api/state')).data;
    expect(state.monthlyRecords.find((record) => record.month === '2026-07').dailyRateFen).toBe(40_000);
  });

  it('批量考勤按一次 revision 原子写入，拒绝重复日期和非法补丁', async () => {
    const running = await startFixture();
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '批量工人', defaultDailyRateFen: 30_000, note: '' }),
    });
    const workerId = created.data.workers[0].id;
    const batch = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [
          { workerId, date: '2026-08-01', morning: 'present', afternoon: 'present' },
          { workerId, date: '2026-08-02', dayNote: '因雨停工' },
        ],
      }),
    });
    expect(batch.response.status).toBe(200);
    expect(batch.data.revision).toBe(2);
    expect(batch.data.attendance).toHaveLength(2);
    expect(batch.data.attendance.find((entry) => entry.date === '2026-08-02')).toMatchObject({
      morning: null,
      dayNote: '因雨停工',
    });

    const addStatus = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({ patches: [{ workerId, date: '2026-08-02', morning: 'present' }] }),
    });
    expect(addStatus.data.attendance.find((entry) => entry.date === '2026-08-02')).toMatchObject({
      morning: 'present',
      dayNote: '因雨停工',
    });
    const clearStatus = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({ patches: [{ workerId, date: '2026-08-02', morning: null }] }),
    });
    expect(clearStatus.data.attendance.find((entry) => entry.date === '2026-08-02')).toMatchObject({
      morning: null,
      dayNote: '因雨停工',
    });
    const clearNote = await api(running, '/api/attendance/day-note', {
      method: 'PUT',
      body: JSON.stringify({ workerId, date: '2026-08-02', dayNote: '' }),
    });
    expect(clearNote.data.attendance.some((entry) => entry.date === '2026-08-02')).toBe(false);

    const duplicate = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [
          { workerId, date: '2026-08-03', morning: 'present' },
          { workerId, date: '2026-08-03', afternoon: 'present' },
        ],
      }),
    });
    expect(duplicate.response.status).toBe(400);
    expect((await api(running, '/api/state')).data.revision).toBe(5);

    const invalid = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [
          { workerId, date: '2026-08-04', morning: 'present' },
          { workerId, date: '2026-02-30', morning: 'present' },
        ],
      }),
    });
    expect(invalid.response.status).toBe(400);
    expect((await api(running, '/api/state')).data.attendance.some((entry) => entry.date === '2026-08-04')).toBe(false);

    const atomic = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [
          { workerId, date: '2026-08-05', morning: 'present' },
          { workerId, date: '2026-08-06', morning: 'present', morningSiteId: 'missing-site' },
        ],
      }),
    });
    expect(atomic.response.status).toBe(404);
    expect((await api(running, '/api/state')).data.attendance.some((entry) => entry.date === '2026-08-05')).toBe(false);

    const tooMany = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({ patches: Array.from({ length: 501 }, (_, index) => ({
        workerId,
        date: `2027-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
        morning: 'present',
      })) }),
    });
    expect(tooMany.response.status).toBe(400);
  });

  it('未来考勤必须明确允许，批量拒绝保持原子性且恢复历史未来记录不受影响', async () => {
    const running = await startFixture({ now: () => new Date('2026-08-14T12:00:00.000Z') });
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '未来测试', defaultDailyRateFen: 30_000, note: '' }),
    });
    const workerId = created.data.workers[0].id;

    const blocked = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [
          { workerId, date: '2026-08-14', morning: 'present' },
          { workerId, date: '2026-08-15', afternoon: 'present' },
        ],
      }),
    });
    expect(blocked.response.status).toBe(409);
    expect(blocked.data.error).toMatchObject({
      code: 'FUTURE_ATTENDANCE_CONFIRMATION_REQUIRED',
      details: { today: '2026-08-14', dates: ['2026-08-15'] },
    });
    expect((await api(running, '/api/state')).data).toMatchObject({ revision: 1, attendance: [] });

    const invalidPermission = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [{ workerId, date: '2026-08-15', morning: 'present' }],
        allowFuture: 'yes',
      }),
    });
    expect(invalidPermission.response.status).toBe(400);

    const allowed = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [{ workerId, date: '2026-08-15', morning: 'present' }],
        allowFuture: true,
      }),
    });
    expect(allowed.response.status).toBe(200);
    expect(allowed.data.attendance[0].date).toBe('2026-08-15');

    const legacy = structuredClone(allowed.data);
    legacy.schemaVersion = 5;
    for (const worker of legacy.workers) delete worker.avatarEmoji;
    for (const record of legacy.monthlyRecords) delete record.paidAt;
    delete legacy.settings.weeklyAutoBackupEnabled;
    delete legacy.settings.lastWeeklyBackupAt;
    const restored = await api(running, '/api/restore', {
      method: 'POST',
      body: JSON.stringify({ data: legacy }),
    });
    expect(restored.response.status).toBe(200);
    expect(restored.data.attendance[0].date).toBe('2026-08-15');
  });

  it('支持工地归档历史引用、默认工地和补贴扣款 CRUD', async () => {
    const running = await startFixture();
    const siteState = await api(running, '/api/sites', {
      method: 'POST',
      body: JSON.stringify({ name: '一号工地', note: '东区' }),
    });
    const siteId = siteState.data.sites[0].id;
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '工地工人', defaultDailyRateFen: 30_000, note: '', defaultSiteId: siteId }),
    });
    const workerId = created.data.workers[0].id;
    const attendance = await api(running, '/api/attendance', {
      method: 'PUT',
      body: JSON.stringify({ workerId, date: '2026-08-08', period: 'morning', status: 'present' }),
    });
    expect(attendance.data.attendance[0].morningSiteId).toBe(siteId);

    const adjustment = await api(running, '/api/pay-adjustments', {
      method: 'POST',
      body: JSON.stringify({
        workerId,
        month: '2026-08',
        date: '2026-08-08',
        kind: 'allowance',
        amountFen: 5_000,
        label: '高温补贴',
        note: '',
      }),
    });
    const adjustmentId = adjustment.data.payAdjustments[0].id;
    const changed = await api(running, `/api/pay-adjustments/${adjustmentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'deduction', amountFen: 1_000, label: '材料扣款' }),
    });
    expect(changed.data.payAdjustments[0]).toMatchObject({ kind: 'deduction', amountFen: 1_000 });

    const missingReassignment = await api(running, `/api/sites/${siteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    });
    expect(missingReassignment.response.status).toBe(400);
    expect(missingReassignment.data.error.code).toBe('SITE_REASSIGN_REQUIRED');

    const archived = await api(running, `/api/sites/${siteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: true, replacementDefaultSiteId: null }),
    });
    expect(archived.data.workers[0].defaultSiteId).toBeNull();
    expect(archived.data.attendance[0].morningSiteId).toBe(siteId);

    const siteUndo = await api(running, '/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({ targets: [{
        entity: 'siteArchive',
        key: { id: siteId },
        before: {
          archivedAt: null,
          workerDefaults: [{ workerId, defaultSiteId: siteId }],
        },
        after: {
          archivedAt: archived.data.sites[0].archivedAt,
          workerDefaults: [{ workerId, defaultSiteId: null }],
        },
      }] }),
    });
    expect(siteUndo.response.status).toBe(200);
    expect(siteUndo.data.sites[0].archivedAt).toBeNull();
    expect(siteUndo.data.workers[0].defaultSiteId).toBe(siteId);

    const clearedHistorical = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({ patches: [{ workerId, date: '2026-08-08', morning: null }] }),
    });
    expect(clearedHistorical.data.attendance.some((entry) => entry.date === '2026-08-08')).toBe(false);
    const undoneHistorical = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({ patches: [{ workerId, date: '2026-08-08', morning: 'present', morningSiteId: siteId }] }),
    });
    expect(undoneHistorical.data.attendance[0]).toMatchObject({ morning: 'present', morningSiteId: siteId });

    const deleted = await api(running, `/api/pay-adjustments/${adjustmentId}`, { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.data.payAdjustments).toEqual([]);
  });

  it('原子撤销月记录与补贴扣款，并用 CAS 阻止覆盖后续修改', async () => {
    const running = await startFixture();
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '撤销工人', defaultDailyRateFen: 30_000, note: '' }),
    });
    const workerId = created.data.workers[0].id;

    const added = await api(running, '/api/pay-adjustments', {
      method: 'POST',
      body: JSON.stringify({
        workerId,
        month: '2026-08',
        date: null,
        kind: 'allowance',
        amountFen: 5_000,
        label: '高温补贴',
        note: '',
      }),
    });
    const addedAdjustment = added.data.payAdjustments[0];
    const addedMonth = added.data.monthlyRecords[0];
    const revertedCreation = await api(running, '/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({
        targets: [
          {
            entity: 'payAdjustment',
            key: { id: addedAdjustment.id },
            before: null,
            after: addedAdjustment,
          },
          {
            entity: 'monthlyRecord',
            key: { workerId, month: '2026-08' },
            before: null,
            after: addedMonth,
          },
        ],
      }),
    });
    expect(revertedCreation.response.status).toBe(200);
    expect(revertedCreation.data.revision).toBe(added.data.revision + 1);
    expect(revertedCreation.data.payAdjustments).toEqual([]);
    expect(revertedCreation.data.monthlyRecords).toEqual([]);

    const recreated = await api(running, '/api/pay-adjustments', {
      method: 'POST',
      body: JSON.stringify({
        workerId,
        month: '2026-08',
        date: '2026-08-08',
        kind: 'deduction',
        amountFen: 1_000,
        label: '材料扣款',
        note: '原记录',
      }),
    });
    const deletedAdjustment = recreated.data.payAdjustments[0];
    await api(running, `/api/pay-adjustments/${deletedAdjustment.id}`, { method: 'DELETE' });
    const restoredDeletion = await api(running, '/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({
        targets: [{
          entity: 'payAdjustment',
          key: { id: deletedAdjustment.id },
          before: deletedAdjustment,
          after: null,
        }],
      }),
    });
    expect(restoredDeletion.response.status).toBe(200);
    expect(restoredDeletion.data.payAdjustments).toContainEqual(deletedAdjustment);

    const beforeOctober = null;
    const octoberFirst = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-10', note: '第一版' }),
    });
    const staleAfter = octoberFirst.data.monthlyRecords.find((record) => record.month === '2026-10');
    const octoberSecond = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-10', note: '第二版' }),
    });
    const conflicted = await api(running, '/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({
        targets: [{
          entity: 'monthlyRecord',
          key: { workerId, month: '2026-10' },
          before: beforeOctober,
          after: staleAfter,
        }],
      }),
    });
    expect(conflicted.response.status).toBe(409);
    expect(conflicted.data.error.code).toBe('UNDO_CONFLICT');
    const stateAfterConflict = (await api(running, '/api/state')).data;
    expect(stateAfterConflict.revision).toBe(octoberSecond.data.revision);
    expect(stateAfterConflict.monthlyRecords.find((record) => record.month === '2026-10').note).toBe('第二版');
    expect(stateAfterConflict.payAdjustments).toContainEqual(deletedAdjustment);

    const invalid = await api(running, '/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({
        targets: [{
          entity: 'payAdjustment',
          key: { id: deletedAdjustment.id },
          before: deletedAdjustment,
          after: deletedAdjustment,
          extra: true,
        }],
      }),
    });
    expect(invalid.response.status).toBe(400);
  });

  it('无副作用检查并迁移旧备份，返回恢复摘要', async () => {
    const running = await startFixture();
    const before = (await api(running, '/api/state')).data;
    const legacy = {
      schemaVersion: 1,
      revision: 4,
      workers: [{
        id: 'legacy', name: '旧工人', defaultDailyRateFen: 100, note: '',
        createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
      }],
      attendance: [{ workerId: 'legacy', date: '2026-01-01', morning: 'present', afternoon: null }],
      monthlyRecords: [],
      settings: { weekStartsOn: 6, currentWorkerId: 'legacy' },
    };
    const inspected = await api(running, '/api/restore/inspect', {
      method: 'POST',
      body: JSON.stringify({ data: legacy }),
    });
    expect(inspected.response.status).toBe(200);
    expect(inspected.data).toMatchObject({
      workerCount: 1,
      archivedWorkerCount: 0,
      attendanceCount: 1,
      monthCount: 0,
      adjustmentCount: 0,
      siteCount: 0,
      workerNames: ['旧工人'],
      data: { schemaVersion: 8, revision: 4 },
    });
    expect((await api(running, '/api/state')).data).toEqual(before);
  });

  it('拒绝跨来源和非 JSON 写入', async () => {
    const running = await startFixture();
    const crossOrigin = await api(running, '/api/workers', {
      method: 'POST',
      headers: { Origin: 'http://example.test' },
      body: JSON.stringify({ name: '陈明', defaultDailyRateFen: 0, note: '' }),
    });
    expect(crossOrigin.response.status).toBe(403);
    expect(crossOrigin.data.error.code).toBe('ORIGIN_REJECTED');

    const notJson = await fetch(`${running.url}/api/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(notJson.status).toBe(415);
  });

  it('拒绝 DNS rebinding Host、跨站 Sec-Fetch 和伪 JSON 类型', async () => {
    const running = await startFixture();
    const port = new URL(running.url).port;
    for (const hostileHost of [
      `evil.test:${port}`,
      `127.0.0.1.evil.test:${port}`,
      `localhost.evil.test:${port}`,
      `user@127.0.0.1:${port}`,
    ]) {
      const result = await rawApi(running, '/api/health', { host: hostileHost });
      expect(result.status).toBe(403);
      expect(result.data.error.code).toBe('LOCAL_ONLY');
    }

    const body = JSON.stringify({ name: '安全工人', defaultDailyRateFen: 0, note: '' });
    const crossSite = await rawApi(running, '/api/workers', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.data.error.code).toBe('ORIGIN_REJECTED');

    for (const contentType of [undefined, 'text/plain', 'application/jsonp']) {
      const result = await rawApi(running, '/api/workers', {
        method: 'POST',
        body,
        headers: contentType ? { 'Content-Type': contentType } : {},
      });
      expect(result.status).toBe(415);
      expect(result.data.error.code).toBe('JSON_REQUIRED');
    }

    const encoded = await rawApi(running, '/api/workers', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
    });
    expect(encoded.status).toBe(415);
    expect(encoded.data.error.code).toBe('UNSUPPORTED_ENCODING');

    const valid = await rawApi(running, '/api/workers', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(valid.status).toBe(200);
    expect(valid.data.workers).toHaveLength(1);
  });

  it('桌面会话密钥保护全部 API，但不阻止静态页面启动', async () => {
    const sessionToken = 'desktop-session-token-abcdefghijklmnopqrstuvwxyz';
    const running = await startFixture({ sessionToken });

    const page = await fetch(`${running.url}/`);
    expect(page.status).toBe(200);

    const missing = await api(running, '/api/health');
    expect(missing.response.status).toBe(401);
    expect(missing.data.error.code).toBe('API_SESSION_REQUIRED');

    const wrong = await api(running, '/api/health', {
      headers: { Authorization: 'Bearer wrong-session-token-0000000000000000' },
    });
    expect(wrong.response.status).toBe(401);

    const authorized = await api(running, '/api/health', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(authorized.response.status).toBe(200);
    expect(authorized.data.app).toBe('jigongben-local');

    const malformed = await api(running, '/api/health', {
      headers: { Authorization: `Basic ${sessionToken}` },
    });
    expect(malformed.response.status).toBe(401);
  });

  it('health 不调用备份列表或读取备份正文', async () => {
    const running = await startFixture();
    let calls = 0;
    running.app.store.listRecoverableBackups = async () => {
      calls += 1;
      throw new Error('health 不应访问此方法');
    };
    const health = await api(running, '/api/health');
    expect(health.response.status).toBe(200);
    expect(health.data.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it('数据损坏时保持只读，并允许用有效备份恢复', async () => {
    const running = await startFixture({ records: '{坏掉的 JSON' });
    const state = await api(running, '/api/state');
    expect(state.response.status).toBe(503);
    expect(state.data).toMatchObject({ readOnly: true, error: { code: 'DATA_CORRUPTED' } });

    const blocked = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '不应写入', defaultDailyRateFen: 0, note: '' }),
    });
    expect(blocked.response.status).toBe(503);
    expect(await readFile(path.join(running.dataDir, 'records.json'), 'utf8')).toBe('{坏掉的 JSON');

    const restored = await api(running, '/api/restore', {
      method: 'POST',
      body: JSON.stringify(emptyAppData()),
    });
    expect(restored.response.status).toBe(200);
    expect(restored.data).toMatchObject({ schemaVersion: 8, revision: 1, settings: { weekStartsOn: 1 } });
    expect((await api(running, '/api/health')).data.ok).toBe(true);
  });

  it('损坏只读状态仍可列出和检查内部备份，且不泄露绝对路径', async () => {
    const backup = emptyAppData();
    backup.revision = 4;
    const running = await startFixture({
      records: '{坏掉的 JSON',
      internalBackups: [
        { name: 'daily-2026-08-22-120000-r4.json', data: backup },
        { name: 'broken.json', data: '{同样损坏' },
      ],
    });

    const listed = await api(running, '/api/internal-backups');
    expect(listed.response.status).toBe(200);
    expect(listed.data.items).toHaveLength(2);
    const item = listed.data.items.find((candidate) => candidate.filename.startsWith('daily-'));
    expect(item).toMatchObject({
      kind: 'daily',
      filename: 'daily-2026-08-22-120000-r4.json',
    });
    expect(item.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(item).not.toHaveProperty('filePath');
    expect(item).not.toHaveProperty('data');
    expect(item).not.toHaveProperty('schemaVersion');
    expect(JSON.stringify(listed.data)).not.toContain(running.root);

    const inspected = await api(running, '/api/internal-backups/inspect', {
      method: 'POST',
      body: JSON.stringify({ id: item.id }),
    });
    expect(inspected.response.status).toBe(200);
    expect(inspected.data).toMatchObject({
      backup: { id: item.id, filename: item.filename },
      schemaVersion: 8,
      workerCount: 0,
      adjustmentCount: 0,
      data: { revision: 4 },
    });
    expect((await api(running, '/api/state')).response.status).toBe(503);

    const brokenItem = listed.data.items.find((candidate) => candidate.filename === 'broken.json');
    const brokenInspection = await api(running, '/api/internal-backups/inspect', {
      method: 'POST',
      body: JSON.stringify({ id: brokenItem.id }),
    });
    expect(brokenInspection.response.status).toBe(422);
    expect(brokenInspection.data.error.code).toBe('INVALID_INTERNAL_BACKUP');

    const traversal = await api(running, '/api/internal-backups/inspect', {
      method: 'POST',
      body: JSON.stringify({ id: '..\\records.json' }),
    });
    expect(traversal.response.status).toBe(400);

    const restored = await api(running, '/api/restore', {
      method: 'POST',
      body: JSON.stringify({ data: inspected.data.data }),
    });
    expect(restored.response.status).toBe(200);
    expect(restored.data.revision).toBe(5);
    expect(
      (await readdir(path.join(running.dataDir, 'backups'))).some(
        (name) => name.startsWith('pre-restore-corrupt-') && name.endsWith('.bin'),
      ),
    ).toBe(true);
  });

  it('请假原子清除出工与工地，普通考勤不能覆盖请假', async () => {
    const running = await startFixture();
    const siteState = await api(running, '/api/sites', {
      method: 'POST',
      body: JSON.stringify({ name: '一号工地', note: '' }),
    });
    const siteId = siteState.data.sites[0].id;
    const workerState = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '请假工人', defaultDailyRateFen: 30_000, defaultSiteId: siteId }),
    });
    const workerId = workerState.data.workers[0].id;
    await api(running, '/api/attendance', {
      method: 'PUT',
      body: JSON.stringify({ workerId, date: '2026-08-08', period: 'morning', status: 'present' }),
    });

    const leave = await api(running, '/api/attendance/leave', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [{ workerId, date: '2026-08-08', period: 'morning', leave: { payType: 'paid' } }],
      }),
    });
    expect(leave.response.status).toBe(200);
    expect(leave.data.attendance[0]).toMatchObject({
      morning: null,
      morningSiteId: null,
      morningLeave: { payType: 'paid' },
    });
    expect(leave.data.monthlyRecords).toHaveLength(1);

    const echoedLeave = await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [{ ...leave.data.attendance[0], dayNote: '只修改备注' }],
      }),
    });
    expect(echoedLeave.response.status).toBe(200);
    expect(echoedLeave.data.attendance[0].dayNote).toBe('只修改备注');

    const locked = await api(running, '/api/attendance', {
      method: 'PUT',
      body: JSON.stringify({ workerId, date: '2026-08-08', period: 'morning', status: 'absent' }),
    });
    expect(locked.response.status).toBe(409);
    expect(locked.data.error.code).toBe('LEAVE_LOCKED');

    const cancelled = await api(running, '/api/attendance/leave', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [{ workerId, date: '2026-08-08', period: 'morning', leave: null }],
      }),
    });
    expect(cancelled.data.attendance[0]).toMatchObject({
      morning: null,
      morningLeave: null,
      dayNote: '只修改备注',
    });

    const adjustment = await api(running, '/api/pay-adjustments', {
      method: 'POST',
      body: JSON.stringify({
        workerId,
        month: '2026-08',
        date: null,
        kind: 'allowance',
        amountFen: 100,
        label: '工地补贴',
        siteId,
      }),
    });
    expect(adjustment.data.payAdjustments[0].siteId).toBe(siteId);
  });

  it('考勤撤销按精确字段 CAS，允许无关字段变化并拒绝同字段冲突', async () => {
    const running = await startFixture();
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '撤销工人', defaultDailyRateFen: 30_000 }),
    });
    const workerId = created.data.workers[0].id;
    await api(running, '/api/attendance/batch', {
      method: 'PUT',
      body: JSON.stringify({
        patches: [{ workerId, date: '2026-08-08', morning: 'present', afternoon: 'absent' }],
      }),
    });
    const target = {
      entity: 'attendance',
      key: { workerId, date: '2026-08-08' },
      fields: ['morning'],
      before: { morning: null },
      after: { morning: 'present' },
    };
    const reverted = await api(running, '/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({ targets: [target] }),
    });
    expect(reverted.response.status).toBe(200);
    expect(reverted.data.attendance[0]).toMatchObject({ morning: null, afternoon: 'absent' });
    const repeatedRevision = reverted.data.revision;
    const repeated = await api(running, '/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({ targets: [target] }),
    });
    expect(repeated.response.status).toBe(200);
    expect(repeated.data.revision).toBe(repeatedRevision);

    await api(running, '/api/attendance', {
      method: 'PUT',
      body: JSON.stringify({ workerId, date: '2026-08-08', period: 'morning', status: 'absent' }),
    });
    const conflict = await api(running, '/api/history/revert', {
      method: 'POST',
      body: JSON.stringify({ targets: [target] }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.data.error.code).toBe('UNDO_CONFLICT');
    expect((await api(running, '/api/state')).data.attendance[0].morning).toBe('absent');
  });

  it('月度草稿的语义空操作不创建记录且不增加 revision', async () => {
    const running = await startFixture();
    const created = await api(running, '/api/workers', {
      method: 'POST',
      body: JSON.stringify({ name: '草稿工人', defaultDailyRateFen: 30_000 }),
    });
    const workerId = created.data.workers[0].id;
    const emptyNote = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-08', note: '' }),
    });
    expect(emptyNote.data.revision).toBe(created.data.revision);
    expect(emptyNote.data.monthlyRecords).toEqual([]);

    const changed = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-08', note: '已保存' }),
    });
    const same = await api(running, '/api/monthly-records', {
      method: 'PUT',
      body: JSON.stringify({ workerId, month: '2026-08', note: '已保存' }),
    });
    expect(same.data.revision).toBe(changed.data.revision);
    expect(same.data.monthlyRecords).toHaveLength(1);
  });

  it('持久化 operationId 回执，相同请求不重复执行且不同请求冲突', async () => {
    const running = await startFixture();
    const init = {
      method: 'POST',
      headers: { 'X-LQ-Operation-Id': 'worker-create-001' },
      body: JSON.stringify({ name: '幂等工人', defaultDailyRateFen: 30_000 }),
    };
    const first = await api(running, '/api/workers', init);
    const second = await api(running, '/api/workers', init);
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(second.data.revision).toBe(first.data.revision);
    expect(second.data.workers).toHaveLength(1);
    expect(second.data.operationReceipts).toContainEqual(expect.objectContaining({
      operationId: 'worker-create-001',
      committedRevision: first.data.revision,
    }));

    const reused = await api(running, '/api/workers', {
      ...init,
      body: JSON.stringify({ name: '其他工人', defaultDailyRateFen: 30_000 }),
    });
    expect(reused.response.status).toBe(409);
    expect(reused.data.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const onDisk = JSON.parse(await readFile(path.join(running.dataDir, 'records.json'), 'utf8'));
    expect(onDisk.operationReceipts).toContainEqual(expect.objectContaining({
      operationId: 'worker-create-001',
    }));
  });

  it('响应正文丢失后使用原 operationId 重放不会重复创建', async () => {
    const running = await startFixture();
    const operationId = 'lost-response-worker-create-001';
    const body = JSON.stringify({ name: '响应丢失工人', defaultDailyRateFen: 30_000 });
    await sendMutationAndDropResponse(running, '/api/workers', body, operationId);

    const committed = await api(running, '/api/state');
    expect(committed.data).toMatchObject({ revision: 1 });
    expect(committed.data.workers).toHaveLength(1);

    const replayed = await api(running, '/api/workers', {
      method: 'POST',
      headers: { 'X-LQ-Operation-Id': operationId },
      body,
    });
    expect(replayed.response.status).toBe(200);
    expect(replayed.data.revision).toBe(committed.data.revision);
    expect(replayed.data.workers).toHaveLength(1);
    expect(replayed.data.workers[0].name).toBe('响应丢失工人');
  });

  it('64 MiB 数据上限为 UTF-8 序列化上限，HTTP 封装保留足够余量', () => {
    const data = emptyAppData();
    data.workers.push({
      id: 'envelope-worker',
      name: '封装测试',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 0,
      note: '中文字节',
      defaultSiteId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });
    const compactBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    const wrappedBytes = Buffer.byteLength(JSON.stringify({ data }), 'utf8');
    expect(MAX_DATA_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_JSON_BYTES - MAX_DATA_BYTES).toBe(64 * 1024);
    expect(wrappedBytes - compactBytes).toBeLessThan(MAX_JSON_BYTES - MAX_DATA_BYTES);
    expect(compactBytes).toBeLessThanOrEqual(appDataSizeBytes(data));
  });

  it('超限恢复在任何备份或正式数据写入前失败', async () => {
    const emptySize = appDataSizeBytes(emptyAppData());
    const scaledLimit = emptySize + 256;
    const running = await startFixture({ maxDataBytes: scaledLimit });
    const oversized = emptyAppData();
    oversized.workers.push({
      id: 'restore-too-large',
      name: '超限恢复',
      avatarDataUrl: null,
      avatarEmoji: null,
      defaultDailyRateFen: 0,
      note: '大'.repeat(1_000),
      defaultSiteId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });
    expect(appDataSizeBytes(oversized)).toBeGreaterThan(scaledLimit);
    const before = (await api(running, '/api/state')).data;

    const rejected = await api(running, '/api/restore', {
      method: 'POST',
      body: JSON.stringify({ data: oversized }),
    });
    expect(rejected.response.status).toBe(413);
    expect(rejected.data.error).toMatchObject({
      code: 'DATA_LIMIT_REACHED',
      details: { limitBytes: scaledLimit },
    });
    expect((await api(running, '/api/state')).data).toEqual(before);
    expect(await readdir(path.join(running.dataDir, 'backups'))).toEqual([]);
    expect((await readdir(running.dataDir)).some((name) => name === 'records.json')).toBe(false);
  });

  it('普通写入返回实体 delta，幂等重复核对返回完整权威状态', async () => {
    const running = await startFixture();
    const init = {
      method: 'POST',
      headers: {
        'X-LQ-Operation-Id': 'delta-worker-create-001',
        'X-LQ-Response-Mode': 'delta',
      },
      body: JSON.stringify({ name: '增量工人', defaultDailyRateFen: 30_000 }),
    };
    const first = await api(running, '/api/workers', init);
    expect(first.data).toMatchObject({
      kind: 'app-data-delta',
      revision: 1,
      upserts: { workers: [expect.objectContaining({ name: '增量工人' })] },
    });
    expect(JSON.stringify(first.data).length).toBeLessThan(16 * 1024);

    const repeated = await api(running, '/api/workers', init);
    expect(repeated.data.kind).toBeUndefined();
    expect(repeated.data).toMatchObject({ schemaVersion: 8, revision: 1 });
    expect(repeated.data.workers).toHaveLength(1);
  });

  it('正式数据缺失但存在备份时进入 RECOVERY_REQUIRED，health 不解析备份正文', async () => {
    const backup = emptyAppData();
    const running = await startFixture({
      internalBackups: [
        { name: 'daily-2026-08-22-120000-r0.json', data: backup },
        { name: 'broken.json', data: '{损坏但不影响 health' },
      ],
    });
    const health = await api(running, '/api/health');
    expect(health.response.status).toBe(503);
    expect(health.data).toMatchObject({
      ok: false,
      readOnly: true,
      error: { code: 'RECOVERY_REQUIRED' },
      recovery: { available: true },
    });
    expect(health.data.dataDirFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(health.data.recovery).not.toHaveProperty('backups');
    expect(JSON.stringify(health.data)).not.toContain(running.root);
    expect((await api(running, '/api/state')).data.error.code).toBe('RECOVERY_REQUIRED');
  });
});
