import type { LineWebhookEvent } from "../line/types";
import { isAdminCommand } from "./commands";

export type LineEventKind = "admin-command" | "question" | "ignored";

function isQuestionEvent(event: LineWebhookEvent): boolean {
  return (
    event.type === "message" &&
    event.message?.type === "text" &&
    event.source?.type === "group" &&
    typeof event.source.groupId === "string" &&
    !!event.replyToken &&
    typeof event.webhookEventId === "string" &&
    typeof event.message.id === "string" &&
    typeof event.message.text === "string" &&
    typeof event.timestamp === "number" &&
    event.message.mention?.mentionees?.some((mentionee) => mentionee.isSelf === true) === true
  );
}

export function classifyLineEvent(event: LineWebhookEvent): LineEventKind {
  if (isAdminCommand(event)) return "admin-command";
  if (isQuestionEvent(event)) return "question";
  return "ignored";
}
