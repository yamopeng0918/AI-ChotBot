import type { Hono } from "hono";

import type { Env } from "../config";
import { requireKnowledgeAdmin } from "../knowledge/admin-auth";
import type { WorkersAiProbeRunner } from "./workers-ai-probes";

export function registerProviderDiagnosticRoutes(
  app: Hono<{ Bindings: Env }>,
  runnerFor: (env: Env) => WorkersAiProbeRunner,
): void {
  const requireAdmin = requireKnowledgeAdmin();
  app.post("/admin/diagnostics/workers-ai-probes", requireAdmin, async (context) => {
    try {
      return context.json(await runnerFor(context.env).run());
    } catch {
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });
}
