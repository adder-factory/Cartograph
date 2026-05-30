<script setup lang="ts">
import { ref, computed } from 'vue'
import { Helper } from './helper'
import Box from './Box.vue'

interface Item {
  name: string
  count: number
}

const item = ref<Item>({ name: 'x', count: 0 })

function increment(it: Item): Item {
  it.count += 1
  Helper.log(it)
  return it
}

const label = computed(() => `${item.value.name}: ${item.value.count}`)
</script>

<template>
  <div>
    <span>{{ label }}</span>
    <button @click="increment(item)">+</button>
    <Box :item="item" />
  </div>
</template>

<style scoped>
div { color: blue; }
</style>
