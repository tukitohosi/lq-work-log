<script setup lang="ts">
export type UiIconName =
  | 'archive'
  | 'calendar'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'close'
  | 'download'
  | 'edit'
  | 'file-spreadsheet'
  | 'file-text'
  | 'folder'
  | 'help'
  | 'more'
  | 'plus'
  | 'printer'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'trash'
  | 'undo'
  | 'upload'
  | 'user-plus'
  | 'users'

withDefaults(defineProps<{
  name: UiIconName
  size?: number
  strokeWidth?: number
}>(), {
  size: 18,
  strokeWidth: 2,
})

const iconPaths = {
  archive: [
    'M3 8h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    'M2 3h20v5H2z',
    'M9 12h6',
  ],
  calendar: [
    'M4 5h16a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
    'M16 2v6',
    'M8 2v6',
    'M2 10h20',
  ],
  check: ['m5 12 4 4L19 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-up': ['m18 15-6-6-6 6'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
  edit: [
    'M12 20h9',
    'M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z',
  ],
  'file-spreadsheet': [
    'M6 2h9l5 5v15H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z',
    'M14 2v6h6',
    'M8 13h8',
    'M8 17h8',
    'M11 11v8',
  ],
  'file-text': [
    'M6 2h9l5 5v15H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z',
    'M14 2v6h6',
    'M8 13h8',
    'M8 17h6',
  ],
  folder: ['M3 5h6l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z'],
  help: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
    'M9.2 9a3 3 0 1 1 5.2 2c-1.2 1-2.4 1.4-2.4 3',
    'M12 18h.01',
  ],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  printer: [
    'M6 9V2h12v7',
    'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
    'M6 14h12v8H6z',
  ],
  refresh: [
    'M20 7h-5V2',
    'M20 7a9 9 0 0 0-15.5-2',
    'M4 17h5v5',
    'M4 17a9 9 0 0 0 15.5 2',
  ],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.35-4.35'],
  settings: [
    'M12 2v3',
    'M12 19v3',
    'M4.93 4.93l2.12 2.12',
    'M16.95 16.95l2.12 2.12',
    'M2 12h3',
    'M19 12h3',
    'M4.93 19.07l2.12-2.12',
    'M16.95 7.05l2.12-2.12',
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  ],
  trash: [
    'M3 6h18',
    'M8 6V3h8v3',
    'M19 6l-1 15H6L5 6',
    'M10 11v6',
    'M14 11v6',
  ],
  undo: ['m9 14-5-5 5-5', 'M4 9h9a7 7 0 0 1 7 7v3'],
  upload: ['M12 21V9', 'm17 14-5-5-5 5', 'M5 3h14'],
  'user-plus': [
    'M15 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2',
    'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M19 8v6',
    'M16 11h6',
  ],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
} satisfies Record<UiIconName, readonly string[]>
</script>

<template>
  <svg
    class="ui-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="path in iconPaths[name]" :key="path" :d="path" />
  </svg>
</template>

<style scoped>
.ui-icon {
  display: inline-block;
  flex: 0 0 auto;
  overflow: visible;
  vertical-align: -0.15em;
}
</style>
