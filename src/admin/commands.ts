import type { GroupAdminSeed } from "./group-admins";
import type { LineWebhookEvent } from "../line/types";

export type AdminCommand = {
  kind: "add" | "remove" | "list";
  target?: GroupAdminSeed;
  rawText: string;
};

const COMMAND_PREFIX = "@bot ";
const ADD_FAMILY = "管理員新增";
const REMOVE_FAMILY = "管理員移除";
const LIST_FAMILY = "管理員列表";

function parseTarget(rawTarget: string): GroupAdminSeed | null {
  if (rawTarget.startsWith("@")) {
    return { userId: "", displayName: rawTarget };
  }

  if (/^U[0-9A-Za-z]+$/.test(rawTarget)) {
    return { userId: rawTarget, displayName: rawTarget };
  }

  return null;
}

export function parseAdminCommand(text: string): AdminCommand | null {
  const rawText = text.trim();
  if (!rawText.startsWith(COMMAND_PREFIX)) return null;

  const content = rawText.slice(COMMAND_PREFIX.length);

  if (content === LIST_FAMILY) {
    return { kind: "list", rawText };
  }

  for (const [family, kind] of [
    [ADD_FAMILY, "add"],
    [REMOVE_FAMILY, "remove"],
  ] as const) {
    const prefix = `${family} `;
    if (!content.startsWith(prefix)) continue;

    const rawTarget = content.slice(prefix.length).trim();
    const target = parseTarget(rawTarget);
    if (target === null) return null;

    return { kind, target, rawText };
  }

  return null;
}

export function resolveAdminTarget(event: LineWebhookEvent, command: AdminCommand): GroupAdminSeed | null {
  if (!command.target) return null;
  if (event.source?.type !== "group") return null;

  if (command.target.userId !== "") {
    return command.target;
  }

  const mentionees = event.message?.mention?.mentionees ?? [];
  const targetMention = mentionees.find(
    (mentionee) => mentionee.isSelf !== true && typeof mentionee.userId === "string",
  );

  if (!targetMention || typeof targetMention.userId !== "string") {
    return null;
  }

  return { userId: targetMention.userId, displayName: command.target.displayName };
}

export function isAdminCommand(event: LineWebhookEvent): boolean {
  return (
    event.type === "message" &&
    event.source?.type === "group" &&
    event.message?.type === "text" &&
    typeof event.message.text === "string" &&
    parseAdminCommand(event.message.text) !== null
  );
}
