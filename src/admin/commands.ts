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
    if (!/^@\S+$/.test(rawTarget)) {
      return null;
    }

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

  const messageText = event.message?.type === "text" ? event.message.text : undefined;
  if (typeof messageText !== "string") {
    return null;
  }

  const trimmedMessageText = messageText.trim();
  if (trimmedMessageText !== command.rawText) {
    return null;
  }

  const leadingWhitespaceLength = messageText.length - messageText.trimStart().length;
  const targetToken = command.target.displayName;
  const targetIndex = command.rawText.length - targetToken.length;
  if (targetIndex < 0 || command.rawText.slice(targetIndex) !== targetToken) {
    return null;
  }

  const mentionees = event.message?.mention?.mentionees ?? [];
  const targetMentions = mentionees.filter(
    (mentionee) =>
      mentionee.isSelf !== true &&
      typeof mentionee.userId === "string" &&
      typeof mentionee.index === "number" &&
      typeof mentionee.length === "number" &&
      mentionee.index === leadingWhitespaceLength + targetIndex &&
      mentionee.length === targetToken.length,
  );

  if (targetMentions.length !== 1) {
    return null;
  }

  const [targetMention] = targetMentions;
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
