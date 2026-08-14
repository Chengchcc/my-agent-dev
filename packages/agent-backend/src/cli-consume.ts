/** Shared CLI-backend consume guard: a rejected stdout-consume promise must
 *  never leave a Run unsettled (an eternally "running" branch). Every CLI
 *  adapter wraps its consume body with this and settles failed on error. */
export async function guardedConsume(
  consume: () => Promise<void>,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await consume();
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
}
