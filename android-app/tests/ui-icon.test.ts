import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UiIcon from '../src/components/UiIcon.vue'

describe('UiIcon', () => {
  it('renders a non-focusable currentColor SVG with stable defaults', () => {
    const wrapper = mount(UiIcon, { props: { name: 'search' } })
    const svg = wrapper.find('svg')

    expect(svg.attributes()).toMatchObject({
      'aria-hidden': 'true',
      focusable: 'false',
      fill: 'none',
      stroke: 'currentColor',
      width: '18',
      height: '18',
      viewBox: '0 0 24 24',
    })
    expect(svg.findAll('path')).toHaveLength(2)
  })

  it('supports typed variants and explicit sizing without external assets', () => {
    const wrapper = mount(UiIcon, {
      props: { name: 'trash', size: 20, strokeWidth: 1.75 },
    })
    const svg = wrapper.find('svg')

    expect(svg.attributes('width')).toBe('20')
    expect(svg.attributes('height')).toBe('20')
    expect(svg.attributes('stroke-width')).toBe('1.75')
    expect(svg.findAll('path')).toHaveLength(5)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('use').exists()).toBe(false)
  })
})
