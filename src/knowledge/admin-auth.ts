import type { MiddlewareHandler } from "hono";

import type { Env } from "../config";

const encoder = new TextEncoder();

export function requireKnowledgeAdmin(): MiddlewareHandler<{ Bindings: Env }> {
  return async (context, next) => {
    const authenticated = await verifyAdminBearer(
      context.req.header("authorization"), context.env.ADMIN_API_TOKEN,
    );
    if (!authenticated) {
      return context.json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
    }
    await next();
  };
}

export async function verifyAdminBearer(
  header: string | undefined,
  expectedToken: string,
): Promise<boolean> {
  if (!header?.startsWith("Bearer ")) return false;

  const token = header.slice("Bearer ".length);
  if (!token) return false;

  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  const actual = new Uint8Array(actualDigest);
  const expected = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < 32; index += 1) {
    difference |= actual[index]! ^ expected[index]!;
  }
  return difference === 0;
}
