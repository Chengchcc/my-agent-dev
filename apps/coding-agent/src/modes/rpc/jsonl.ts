/** Strict LF-framed JSONL reader (Pi-style).
 *
 *  - Only `\n` (0x0A) splits frames - a generic line reader that also splits
 *    on Unicode separators would corrupt payloads.
 *  - Byte-buffer based: half packets accumulate until the next LF.
 *  - A single frame is bounded (`maxLineBytes`); oversized frames are skipped
 *    and reported via `onOversize`. The buffer is trimmed so a hostile peer
 *    cannot grow memory without bound - trimmed bytes belong to an oversized
 *    frame, which is discarded up to its terminating LF. */

export interface JsonlReaderOptions {
  /** Max bytes of one frame (default 16 MiB - history projections can be large). */
  maxLineBytes?: number;
  onOversize?: (length: number) => void;
}

export interface JsonlReader {
  readonly lines: AsyncIterable<string>;
  /** End the read loop as if the stream closed: the pending read resolves
   *  `{done: true}` and the iterator finishes cleanly. Used by RPC mode to
   *  exit the process on its own after the outcome. */
  cancel(): Promise<void>;
}

export function createJsonlReader(
  stream: ReadableStream<Uint8Array>,
  opts: JsonlReaderOptions = {},
): JsonlReader {
  const maxLineBytes = opts.maxLineBytes ?? 16 * 1024 * 1024;
  const reader = stream.getReader();
  const lines = (async function* (): AsyncIterable<string> {
    const decoder = new TextDecoder("utf-8");
    let buffer = new Uint8Array(0);
    // True while the buffered bytes belong to a frame already known to
    // exceed the bound: everything up to the next LF is discarded.
    let inOversize = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length === 0) continue;
        // Append the chunk.
        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer, 0);
        next.set(value, buffer.length);
        buffer = next;
        // Split on LF only.
        let start = 0;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] !== 0x0a) continue;
          const lineLen = i - start;
          if (inOversize) {
            // The LF terminates the truncated oversized frame: discard it.
            inOversize = false;
          } else if (lineLen <= maxLineBytes) {
            yield decoder.decode(buffer.subarray(start, i));
          } else {
            // The frame ended at this LF (it is complete but oversized).
            opts.onOversize?.(lineLen);
          }
          start = i + 1;
        }
        buffer = buffer.slice(start);
        // Memory bound: a partial frame longer than the bound can never
        // become a valid line - drop it, discard up to the next LF.
        if (buffer.length > maxLineBytes) {
          inOversize = true;
          buffer = new Uint8Array(0);
        }
      }
      // Trailing frame without a final LF.
      if (buffer.length > 0) {
        if (!inOversize && buffer.length <= maxLineBytes) {
          yield decoder.decode(buffer);
        } else if (!inOversize) {
          opts.onOversize?.(buffer.length);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  })();
  return {
    lines,
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    },
  };
}
