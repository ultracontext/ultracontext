import { UltraContext } from "ultracontext";
import type { ContextReader } from "./types.js";

// -- SDK-backed reader (used by stdio + http standalone transports) -----------

export function sdkReader(uc: UltraContext): ContextReader {
  return {
    listContexts: (input) => uc.get(input),

    getMessages: async (id) => {
      try {
        const res = await uc.get(id);
        return {
          data: res.data.map((m: any, i: number) => ({
            ...m,
            id: m.id,
            index: i,
            metadata: m.metadata,
          })),
        };
      } catch {
        return null;
      }
    },
  };
}
