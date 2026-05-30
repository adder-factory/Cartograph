<script lang="ts">
  import { Helper } from './helper';
  import type { Box } from './types';

  export let item: Box;
  export let label: string;
  export let count: number = 0;

  function increment(b: Box): Box {
    count += 1;
    Helper.log(b);
    return b;
  }
</script>

<div>
  <span>{label}: {count}</span>
  <button on:click={() => increment(item)}>+</button>
</div>
