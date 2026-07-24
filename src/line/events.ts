import { isAdminCommand } from "../admin/commands";
import type { LineWebhookBody, MentionedMessage } from "./types";

export function selectMentionedMessages(
  payload: LineWebhookBody,
  allowedGroupId: string,
): MentionedMessage[] {
  const selected: MentionedMessage[] = [];

  for (const event of payload.events) {
    if (
      event.type !== "message" ||
      event.message?.type !== "text" ||
      event.source?.type !== "group" ||
      event.source.groupId !== allowedGroupId ||
      !event.replyToken ||
      isAdminCommand(event) ||
      !event.message.mention?.mentionees?.some((mentionee) => mentionee.isSelf === true) ||
      typeof event.webhookEventId !== "string" ||
      typeof event.message.id !== "string" ||
      typeof event.message.text !== "string" ||
      typeof event.timestamp !== "number"
    ) {
      continue;
    }

    selected.push({
      webhookEventId: event.webhookEventId,
      replyToken: event.replyToken,
      groupId: event.source.groupId,
      userId: event.source.userId ?? null,
      messageId: event.message.id,
      text: event.message.text,
      timestamp: event.timestamp,
    });
  }

  return selected;
}
