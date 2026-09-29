<script setup lang="ts">
import { useId } from 'vue'
import type { GlobalSearchResult, GlobalSearchResultKind } from '../search'
import UiIcon from './UiIcon.vue'

defineProps<{
  open: boolean
  query: string
  results: readonly GlobalSearchResult[]
}>()

const emit = defineEmits<{
  close: []
  'update:query': [value: string]
  select: [result: GlobalSearchResult]
}>()

const titleId = useId()
const descriptionId = useId()

const kindLabels: Record<GlobalSearchResultKind, string> = {
  worker: '工人',
  'day-note': '日备注',
  'monthly-note': '月备注',
  adjustment: '补贴扣款',
}

function updateQuery(event: Event): void {
  emit('update:query', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div
    v-if="open"
    class="global-search-backdrop"
    @mousedown.self="emit('close')"
    @keydown.esc.stop.prevent="emit('close')"
  >
    <section
      class="global-search-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="descriptionId"
    >
      <header class="global-search-dialog__header">
        <div>
          <h2 :id="titleId">全局搜索</h2>
          <p :id="descriptionId">搜索工人姓名、备注以及补贴扣款项目</p>
        </div>
        <button type="button" class="global-search-dialog__close" aria-label="关闭搜索" @click="emit('close')"><UiIcon name="close" /></button>
      </header>

      <label class="global-search-dialog__field">
        <span class="global-search-dialog__field-label">搜索内容</span>
        <UiIcon class="global-search-dialog__search-icon" name="search" />
        <input
          type="search"
          :value="query"
          placeholder="输入姓名、备注或项目名称"
          autocomplete="off"
          autofocus
          @input="updateQuery"
        >
      </label>

      <div class="global-search-dialog__summary" role="status" aria-live="polite">
        <template v-if="query.trim()">找到 {{ results.length }} 条结果</template>
        <template v-else>输入关键词开始搜索</template>
      </div>

      <ul v-if="results.length" class="global-search-results" aria-label="搜索结果">
        <li v-for="result in results" :key="result.id">
          <button type="button" class="global-search-result" @click="emit('select', result)">
            <span class="global-search-result__topline">
              <span class="global-search-result__kind">{{ kindLabels[result.kind] }}</span>
              <strong>{{ result.title }}</strong>
              <span v-if="result.archived" class="global-search-result__archived">已归档</span>
            </span>
            <span class="global-search-result__snippet">{{ result.snippet }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="query.trim()" class="global-search-dialog__empty">没有找到匹配内容。</p>
    </section>
  </div>
</template>

<style scoped>
.global-search-backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0 0 auto;
  height: var(--visual-viewport-height, 100dvh);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  place-items: start center;
  padding: min(8vh, 40px) 20px 20px;
  overflow-y: auto;
  background: rgb(15 23 42 / 45%);
}

.global-search-dialog {
  width: min(680px, 100%);
  min-width: 0;
  max-height: min(100%, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgb(148 163 184 / 40%);
  border-radius: 18px;
  background: var(--surface, #fff);
  color: var(--ink, #172033);
  box-shadow: 0 24px 70px rgb(15 23 42 / 24%);
}

.global-search-dialog__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 22px 12px;
}

.global-search-dialog__header h2,
.global-search-dialog__header p {
  margin: 0;
}

.global-search-dialog__header p {
  margin-top: 4px;
  color: var(--muted, #64748b);
  font-size: 13px;
}

.global-search-dialog__close {
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 26px;
  line-height: 1;
  cursor: pointer;
}

.global-search-dialog__close:hover {
  background: rgb(148 163 184 / 16%);
}

.global-search-dialog__field {
  position: relative;
  padding: 0 22px;
}

.global-search-dialog__search-icon {
  position: absolute;
  top: 50%;
  left: 36px;
  z-index: 1;
  color: var(--muted, #64748b);
  transform: translateY(-50%);
  pointer-events: none;
}

.global-search-dialog__field-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

.global-search-dialog__field input {
  box-sizing: border-box;
  width: 100%;
  padding: 12px 14px 12px 42px;
  border: 1px solid var(--line, #cbd5e1);
  border-radius: 11px;
  background: var(--surface-soft, #f8fafc);
  color: inherit;
  font: inherit;
  outline: none;
}

.global-search-dialog__field input:focus-visible {
  border-color: var(--green, #3b6fe8);
  box-shadow: 0 0 0 3px var(--green-soft, rgb(59 111 232 / 16%));
}

.global-search-dialog__summary {
  padding: 10px 22px;
  color: var(--muted, #64748b);
  font-size: 12px;
}

.global-search-results {
  min-height: 0;
  margin: 0;
  padding: 0 10px 14px;
  overflow: auto;
  list-style: none;
}

.global-search-result {
  width: 100%;
  padding: 11px 12px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.global-search-result:hover,
.global-search-result:focus-visible {
  background: rgb(59 111 232 / 9%);
  outline: none;
}

.global-search-result__topline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
}

.global-search-result__kind,
.global-search-result__archived {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgb(59 111 232 / 12%);
  color: var(--green, #315fc4);
  font-size: 11px;
}

.global-search-result__archived {
  background: rgb(100 116 139 / 14%);
  color: var(--muted, #64748b);
}

.global-search-result__snippet {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: var(--muted, #64748b);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.global-search-dialog__empty {
  margin: 0;
  padding: 28px 22px 38px;
  color: var(--muted, #64748b);
  text-align: center;
}

@media screen and (max-width: 760px) {
  .global-search-backdrop {
    inset: 0 0 auto;
    height: var(--visual-viewport-height, 100dvh);
    padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
    align-items: start;
    overflow-y: auto;
  }
  .global-search-dialog { width: 100%; max-height: 100%; }
  .global-search-dialog__header { padding: 14px 14px 10px; gap: 8px; }
  .global-search-dialog__header > div { min-width: 0; overflow-wrap: anywhere; }
  .global-search-dialog__close { width: 44px; height: 44px; flex: 0 0 44px; }
  .global-search-dialog__field { min-width: 0; padding-inline: 14px; }
  .global-search-dialog__field input { min-width: 0; min-height: 44px; }
  .global-search-dialog__search-icon { left: 28px; }
  .global-search-dialog__summary { padding-inline: 14px; }
  .global-search-result { min-height: 44px; }
}
</style>
