<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Worker } from '../types'

const props = withDefaults(defineProps<{
  worker: Pick<Worker, 'name' | 'avatarDataUrl' | 'avatarEmoji'>
  size?: number | string
}>(), {
  size: 40,
})

const imageFailed = ref(false)

watch(() => props.worker.avatarDataUrl, () => {
  imageFailed.value = false
})

const avatarSize = computed(() => {
  if (typeof props.size === 'number') return `${Math.max(1, props.size)}px`
  return props.size || '40px'
})

const emoji = computed(() => props.worker.avatarEmoji?.trim() ?? '')
const initial = computed(() => Array.from(props.worker.name.trim())[0] ?? '？')
const showImage = computed(() => Boolean(props.worker.avatarDataUrl) && !imageFailed.value)
</script>

<template>
  <span
    class="worker-avatar"
    :style="{ '--worker-avatar-size': avatarSize }"
    role="img"
    :aria-label="`${worker.name || '工人'}的头像`"
  >
    <img
      v-if="showImage"
      class="worker-avatar__image"
      :src="worker.avatarDataUrl ?? ''"
      alt=""
      aria-hidden="true"
      @error="imageFailed = true"
    >
    <span v-else-if="emoji" class="worker-avatar__emoji" aria-hidden="true">{{ emoji }}</span>
    <span v-else class="worker-avatar__initial" aria-hidden="true">{{ initial }}</span>
  </span>
</template>

<style scoped>
.worker-avatar {
  display: inline-grid;
  width: var(--worker-avatar-size);
  height: var(--worker-avatar-size);
  flex: 0 0 var(--worker-avatar-size);
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: var(--green-soft, linear-gradient(145deg, #eef4ff, #dce8ff));
  color: var(--green, #31558a);
  font-size: calc(var(--worker-avatar-size) * 0.42);
  font-weight: 700;
  line-height: 1;
  vertical-align: middle;
}

.worker-avatar__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.worker-avatar__emoji {
  font-size: calc(var(--worker-avatar-size) * 0.58);
  font-family: "Segoe UI Emoji", "Apple Color Emoji", sans-serif;
}

.worker-avatar__initial {
  text-transform: uppercase;
}
</style>
