import type { Hono } from "hono";

import type { Env } from "../config";
import { verifyAdminBearer } from "./admin-auth";
import type { KnowledgeRepository } from "./repository";

export type KnowledgeReader = Pick<KnowledgeRepository, "listDocuments" | "getDocument">;

export function registerKnowledgeAdminRoutes(
  app: Hono<{ Bindings: Env }>,
  repositoryFor: (env: Env) => KnowledgeReader,
): void {
  app.use("/admin/knowledge/*", async (context, next) => {
    const authenticated = await verifyAdminBearer(
      context.req.header("authorization"), context.env.ADMIN_API_TOKEN,
    );
    if (!authenticated) {
      return context.json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
    }
    await next();
  });

  app.get("/admin/knowledge/documents", async (context) => {
    try {
      return context.json({ documents: await repositoryFor(context.env).listDocuments() });
    } catch {
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });

  app.get("/admin/knowledge/documents/:id", async (context) => {
    try {
      const document = await repositoryFor(context.env).getDocument(context.req.param("id"));
      if (!document) {
        return context.json({
          error: { code: "document_not_found", message: "Document not found" },
        }, 404);
      }
      return context.json({ document });
    } catch {
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });
}
