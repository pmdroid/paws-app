export async function settleReactWork(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
