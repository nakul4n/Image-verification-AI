export function reportRuntimeError(error: unknown, context: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === "development") {
    console.warn("[Runtime Error Captured]:", error, context);
  }
}
