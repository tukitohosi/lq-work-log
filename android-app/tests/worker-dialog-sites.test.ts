import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import WorkerDialog from '../src/components/WorkerDialog.vue'
import type { Site, Worker } from '../src/types'

const oldSite: Site = { id: 'old', name: '原工地', note: '', createdAt: '2026-09-01T00:00:00.000Z', archivedAt: null }
const newSite: Site = { ...oldSite, id: 'new', name: '新增工地' }
const worker: Worker = {
  id: 'worker', name: '原姓名', avatarDataUrl: null, avatarEmoji: null, defaultDailyRateFen: 20000,
  note: '原备注', defaultSiteId: oldSite.id, createdAt: oldSite.createdAt, archivedAt: null,
}

function setup(createSite = vi.fn<(payload: { name: string; note: string }) => Promise<Site>>().mockResolvedValue(newSite)) {
  const cancelSiteCreation = vi.fn()
  const wrapper = mount(WorkerDialog, { props: {
    open: true, mode: 'edit', worker, sites: [oldSite], existingNames: [worker.name],
    submitting: false, serverError: '', batchResult: null, createSite, cancelSiteCreation,
  } })
  return { wrapper, createSite, cancelSiteCreation }
}

describe('worker dialog inline site creation', () => {
  it('preserves worker drafts, selects the returned id, and waits for worker Save before submitting', async () => {
    const { wrapper, createSite } = setup()
    await wrapper.get('.worker-profile-form input[maxlength="40"]').setValue('已编辑姓名')
    await wrapper.get('.worker-profile-form textarea').setValue('未保存备注')
    await wrapper.get('.worker-default-site').setValue('__create_site__')
    expect(wrapper.get('.worker-profile-form').isVisible()).toBe(false)
    await wrapper.get('.worker-site-form input').setValue(' 新增工地 ')
    await wrapper.get('.worker-site-form textarea').setValue(' 备注 ')
    await wrapper.get('.worker-site-form').trigger('submit')
    await flushPromises()
    expect(createSite).toHaveBeenCalledWith({ name: '新增工地', note: '备注' })
    expect(wrapper.find('.worker-site-form').exists()).toBe(false)
    expect(wrapper.get<HTMLSelectElement>('.worker-default-site').element.value).toBe('new')
    expect(wrapper.emitted('submit-single')).toBeUndefined()
    await wrapper.get('.worker-profile-form').trigger('submit')
    expect(wrapper.emitted('submit-single')?.[0]?.[0]).toMatchObject({ name: '已编辑姓名', note: '未保存备注', defaultSiteId: 'new' })
    wrapper.unmount()
  })

  it('returns from the child header close with the original selection and no worker close', async () => {
    const { wrapper, createSite, cancelSiteCreation } = setup()
    await wrapper.get('.worker-default-site').setValue('__create_site__')
    await wrapper.get('.worker-site-form input').setValue('未保存工地')
    await wrapper.get('.modal-header button').trigger('click')
    expect(wrapper.find('.worker-site-form').exists()).toBe(false)
    expect(wrapper.get<HTMLSelectElement>('.worker-default-site').element.value).toBe('old')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(createSite).not.toHaveBeenCalled()
    expect(cancelSiteCreation).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('retains failed site input, prevents duplicate saves, and allows retry', async () => {
    let reject!: (reason: unknown) => void
    const createSite = vi.fn<(payload: { name: string; note: string }) => Promise<Site>>()
      .mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
      .mockResolvedValueOnce(newSite)
    const { wrapper } = setup(createSite)
    await wrapper.get('.worker-default-site').setValue('__create_site__')
    await wrapper.get('.worker-site-form input').setValue('新增工地')
    await wrapper.get('.worker-site-form textarea').setValue('保留备注')
    await wrapper.get('.worker-site-form').trigger('submit')
    await wrapper.get('.worker-site-form').trigger('submit')
    expect(createSite).toHaveBeenCalledOnce()
    expect(wrapper.get('.modal-header button').attributes('disabled')).toBeDefined()
    reject(new Error('磁盘忙'))
    await flushPromises()
    expect(wrapper.get('.worker-site-form [role="alert"]').text()).toBe('磁盘忙')
    expect(wrapper.get<HTMLInputElement>('.worker-site-form input').element.value).toBe('新增工地')
    expect(wrapper.get<HTMLTextAreaElement>('.worker-site-form textarea').element.value).toBe('保留备注')
    await wrapper.get('.worker-site-form').trigger('submit')
    await flushPromises()
    expect(createSite).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('offers an existing active match and warns about archived matches without restoring them', async () => {
    const { wrapper, createSite } = setup()
    const archived = { ...oldSite, id: 'archived', archivedAt: '2026-09-02T00:00:00.000Z' }
    await wrapper.setProps({ allSites: [oldSite, archived] })
    await wrapper.get('.worker-default-site').setValue('__create_site__')
    await wrapper.get('.worker-site-form input').setValue('原工地')
    expect(wrapper.get('.worker-site-form .warning-text').text()).toContain('不会恢复旧工地')
    await wrapper.get('.worker-site-matches button').trigger('click')
    expect(wrapper.get<HTMLSelectElement>('.worker-default-site').element.value).toBe('old')
    expect(createSite).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ignores late success after the dialog switches to another worker', async () => {
    let resolve!: (site: Site) => void
    const createSite = vi.fn(() => new Promise<Site>((yes) => { resolve = yes }))
    const { wrapper } = setup(createSite)
    await wrapper.get('.worker-default-site').setValue('__create_site__')
    await wrapper.get('.worker-site-form input').setValue('新增工地')
    await wrapper.get('.worker-site-form').trigger('submit')
    await wrapper.setProps({ worker: { ...worker, id: 'other', name: '另一人', defaultSiteId: null } })
    resolve(newSite)
    await flushPromises()
    expect(wrapper.get<HTMLSelectElement>('.worker-default-site').element.value).toBe('')
    expect(wrapper.get<HTMLInputElement>('.worker-profile-form input[maxlength="40"]').element.value).toBe('另一人')
    wrapper.unmount()
  })

  it('supports the add-worker flow and does not delete a successfully created site when cancelling the worker', async () => {
    const { wrapper, createSite } = setup()
    await wrapper.setProps({ mode: 'add', worker: null })
    await wrapper.get('.worker-default-site').setValue('__create_site__')
    await wrapper.get('.worker-site-form input').setValue('新增工地')
    await wrapper.get('.worker-site-form').trigger('submit')
    await flushPromises()
    await wrapper.get('.modal-header button').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('submit-single')).toBeUndefined()
    expect(createSite).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
})
