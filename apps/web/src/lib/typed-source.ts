import type { SSEEventMap } from "@chengchenccc/api-contract";
import type { z } from "zod";

/** typedSource wraps EventSource with zod schema validation per event name.
 *  EventSource lifecycle (onopen/onerror/readyState/reconnect) is fully preserved. */
export function typedSource<M extends SSEEventMap>(
  url: string,
  map: M,
  opts?: { onError?: (event: string, err: unknown) => void },
) {
  const es = new EventSource(url);

  return {
    es,
    on<K extends keyof M & string>(name: K, cb: (data: z.infer<M[K]>) => void) {
      es.addEventListener(name, (e: Event) => {
        const me = e as MessageEvent;
        try {
          const parsed = JSON.parse(me.data);
          const schema = map[name] as z.ZodType;
          const result = schema.safeParse(parsed);
          if (result.success) {
            cb(result.data);
          } else {
            opts?.onError?.(name, result.error);
          }
        } catch (err) {
          opts?.onError?.(name, err);
        }
      });
    },
    close: () => es.close(),
    readyState: es.readyState,
  };
}
