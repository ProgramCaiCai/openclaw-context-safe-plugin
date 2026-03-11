import { applyContextToolResultPolicy, type ContextSafeMessage } from "./tool-result-policy.js";

export function createContextSafeContextEngine() {
  return {
    info: {
      id: "context-safe",
      name: "Context Safe",
      ownsCompaction: false,
    },
    async ingest() {
      return { ingested: false };
    },
    async afterTurn() {
      return;
    },
    async assemble(params: {
      sessionId: string;
      messages: ContextSafeMessage[];
      tokenBudget?: number;
    }) {
      const result = applyContextToolResultPolicy({
        messages: params.messages,
        contextWindowTokens: Math.max(1, Math.floor(params.tokenBudget ?? 0)),
      });
      return {
        messages: result.messages,
        estimatedTokens: Math.max(1, Math.ceil(result.estimatedChars / 4)),
      };
    },
    async compact(_params: { sessionId: string; sessionFile: string; tokenBudget?: number }) {
      return {
        ok: true,
        compacted: false,
        reason: "context-safe assemble-only engine",
      };
    },
  };
}
