/** Slow fake omp CLI: sleeps long enough for stop() to interrupt. */
await Bun.sleep(30_000);
console.log('{"type":"agent_start"}');
