import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MobileMonthCalendar from '../src/components/MobileMonthCalendar.vue'
import { monthWeeks, weekdayLabels } from '../src/date'
import type { AttendancePeriod, AttendanceValue, OrdinaryLeave, OvertimeLeave, WeekStartsOn } from '../src/types'

function calendar(month = '2026-09', start: WeekStartsOn = 1) {
  return mount(MobileMonthCalendar, {
    props: {
      workerId: 'worker-one', month, weeks: monthWeeks(month, start, '2026-09-29'),
      headers: weekdayLabels(start), readOnly: false, failedDateKeys: new Set<string>(),
      attendanceFor: () => undefined,
      statusValue: (_worker: string, _date: string, _period: AttendancePeriod): AttendanceValue => null,
      leaveValue: (_worker: string, _date: string, _period: AttendancePeriod): OrdinaryLeave | OvertimeLeave | null => null,
    },
  })
}

describe('mobile month calendar', () => {
  it('marks a date when an attendance period failed even without a note error', async () => {
    const wrapper = calendar()
    await wrapper.setProps({ failedCellKeys: new Set(['worker-one|2026-09-03|afternoon']) })
    expect(wrapper.get('[data-mobile-date="2026-09-03"]').classes()).toContain('has-save-error')
    expect(wrapper.get('[data-mobile-date="2026-09-03"]').attributes('aria-label')).toContain('保存失败')
    expect(wrapper.get('[data-mobile-date="2026-09-04"]').classes()).not.toContain('has-save-error')
    wrapper.unmount()
  })
  it.each([
    ['2026-02', 28, 0], ['2026-02', 28, 1], ['2024-02', 29, 0], ['2024-02', 29, 1],
    ['2026-09', 30, 0], ['2026-09', 30, 1], ['2026-08', 31, 0], ['2026-08', 31, 1],
  ] as const)('shows every day of %s once with %d days and week start %d', (month, count, start) => {
    const wrapper = calendar(month, start)
    const actual = wrapper.findAll('[data-mobile-date]').map(button => button.attributes('data-mobile-date'))
    expect(actual).toEqual(Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`))
    expect(wrapper.findAll('.mobile-calendar-week').length).toBeGreaterThanOrEqual(4)
    expect(wrapper.findAll('.mobile-calendar-week').length).toBeLessThanOrEqual(6)
    expect(wrapper.findAll('.mobile-calendar-week').every(week => week.element.children.length === 7)).toBe(true)
    expect(wrapper.findAll('.mobile-calendar-weekdays span').map(header => header.text())).toEqual(weekdayLabels(start))
    wrapper.unmount()
  })

  it('includes six rows when the month requires them and four for aligned February', () => {
    const six = calendar('2026-08', 0)
    const four = calendar('2026-02', 0)
    expect(six.findAll('.mobile-calendar-week')).toHaveLength(6)
    expect(four.findAll('.mobile-calendar-week')).toHaveLength(4)
    six.unmount()
    four.unmount()
  })

  it('opens the exact worker/date and exposes all three period meanings', async () => {
    const wrapper = calendar()
    await wrapper.setProps({
      statusValue: (_worker: string, _date: string, period: AttendancePeriod) => period === 'overtime' ? 'half' : 'present',
      leaveValue: (_worker: string, _date: string, period: AttendancePeriod) => period === 'afternoon' ? { payType: 'unpaid' } : null,
      failedDateKeys: new Set(['worker-one|2026-09-03']),
    })
    const day = wrapper.get('[data-mobile-date="2026-09-03"]')
    expect(day.attributes('aria-label')).toContain('上午出工，下午无薪请假，加班半工')
    expect(day.attributes('aria-label')).toContain('保存失败')
    expect(day.findAll('.mobile-period-state').map(state => state.text())).toEqual(['上✓', '下假', '加½'])
    await day.trigger('click')
    expect(wrapper.emitted('open-day')).toEqual([['worker-one', '2026-09-03']])
    expect(wrapper.emitted('batch')).toBeUndefined()
    wrapper.unmount()
  })

  it('allows vertical swipe and cancelled touch without opening or selecting a day', async () => {
    const wrapper = calendar()
    const day = wrapper.get('[data-mobile-date="2026-09-03"]')
    const grid = wrapper.get('.mobile-calendar-weeks')
    day.element.dispatchEvent(new MouseEvent('pointerdown', { clientX: 40, clientY: 100, bubbles: true }))
    grid.element.dispatchEvent(new MouseEvent('pointermove', { clientX: 42, clientY: 160, bubbles: true }))
    await day.trigger('click')
    expect(wrapper.emitted('open-day')).toBeUndefined()
    await wrapper.get('.mobile-calendar-actions button').trigger('click')
    day.element.dispatchEvent(new MouseEvent('pointerdown', { clientX: 40, clientY: 100, bubbles: true }))
    await grid.trigger('pointercancel')
    await day.trigger('click')
    expect(day.attributes('aria-pressed')).toBe('false')
    day.element.dispatchEvent(new MouseEvent('pointerdown', { clientX: 40, clientY: 100, bubbles: true }))
    day.element.dispatchEvent(new MouseEvent('pointerup', { clientX: 41, clientY: 101, bubbles: true }))
    await day.trigger('click')
    expect(day.attributes('aria-pressed')).toBe('true')
    expect(wrapper.emitted('batch')).toBeUndefined()
    wrapper.unmount()
  })

  it('requires explicit apply and emits the selected legal overtime value once', async () => {
    const wrapper = calendar()
    await wrapper.get('.mobile-calendar-actions button').trigger('click')
    await wrapper.get('[data-mobile-date="2026-09-03"]').trigger('click')
    await wrapper.get('[data-mobile-date="2026-09-01"]').trigger('click')
    expect(wrapper.emitted('open-day')).toBeUndefined()
    expect(wrapper.emitted('batch')).toBeUndefined()
    await wrapper.get('[aria-label="批量时段"]').setValue('overtime')
    expect(wrapper.get('[aria-label="批量状态"]').findAll('option').map(option => option.attributes('value'))).toEqual(['half', 'full', 'blank', 'leave'])
    await wrapper.get('[aria-label="批量状态"]').setValue('full')
    await wrapper.get('.mobile-batch-form').trigger('submit')
    expect(wrapper.emitted('batch')).toEqual([[['2026-09-01', '2026-09-03'], 'overtime', 'full']])
    expect(wrapper.find('.mobile-batch-form').exists()).toBe(false)
    wrapper.unmount()
  })

  it('selects only the current week dates in this month and supports clear/all/cancel', async () => {
    const wrapper = calendar()
    await wrapper.get('.mobile-calendar-actions button').trigger('click')
    const shortcuts = wrapper.findAll('.mobile-batch-shortcuts button')
    await shortcuts[0]!.trigger('click')
    expect(wrapper.findAll('[aria-pressed="true"]').map(button => button.attributes('data-mobile-date'))).toEqual(['2026-09-28', '2026-09-29', '2026-09-30'])
    await shortcuts[1]!.trigger('click')
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(30)
    await shortcuts[2]!.trigger('click')
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(0)
    expect(wrapper.get('.mobile-batch-apply').attributes('disabled')).toBeDefined()
    await shortcuts[1]!.trigger('click')
    await wrapper.get('.mobile-batch-cancel').trigger('click')
    await wrapper.get('.mobile-calendar-actions button').trigger('click')
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(0)
    await wrapper.setProps({ month: '2026-08', weeks: monthWeeks('2026-08', 1, '2026-09-29') })
    await wrapper.get('.mobile-calendar-actions button').trigger('click')
    expect(wrapper.findAll('.mobile-batch-shortcuts button')[0]!.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it.each(['worker', 'month', 'readOnly'])('clears pending selections when %s changes', async change => {
    const wrapper = calendar()
    await wrapper.get('.mobile-calendar-actions button').trigger('click')
    await wrapper.get('[data-mobile-date="2026-09-03"]').trigger('click')
    if (change === 'worker') await wrapper.setProps({ workerId: 'worker-two' })
    if (change === 'month') await wrapper.setProps({ month: '2026-08', weeks: monthWeeks('2026-08', 1) })
    if (change === 'readOnly') await wrapper.setProps({ readOnly: true })
    expect(wrapper.find('.mobile-batch-form').exists()).toBe(false)
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(0)
    expect(wrapper.emitted('batch')).toBeUndefined()
    wrapper.unmount()
  })

  it('sends leave through the existing leave flow and maps clear to null', async () => {
    const wrapper = calendar()
    await wrapper.get('.mobile-calendar-actions button').trigger('click')
    await wrapper.get('[data-mobile-date="2026-09-03"]').trigger('click')
    await wrapper.get('[aria-label="批量状态"]').setValue('leave')
    await wrapper.get('.mobile-batch-form').trigger('submit')
    expect(wrapper.emitted('batch-leave')).toEqual([[['2026-09-03'], 'morning']])
    await wrapper.get('.mobile-calendar-actions button').trigger('click')
    await wrapper.get('[data-mobile-date="2026-09-04"]').trigger('click')
    await wrapper.get('[aria-label="批量状态"]').setValue('blank')
    await wrapper.get('.mobile-batch-form').trigger('submit')
    expect(wrapper.emitted('batch')).toEqual([[['2026-09-04'], 'morning', null]])
    wrapper.unmount()
  })
})
