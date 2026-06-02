export async function runSequential<T>(
  items: readonly T[],
  visitor: (item: T, index: number) => Promise<boolean>,
): Promise<void> {
  let index = 0;
  while (index < items.length) {
    const shouldContinue = await visitor(items[index]!, index);
    if (!shouldContinue) return;
    index++;
  }
}
