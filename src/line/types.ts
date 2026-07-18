export interface LineWebhookBody {
  destination?: string;
  events: LineWebhookEvent[];
}

export interface LineWebhookEvent {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  timestamp?: number;
  source?: {
    type: string;
    groupId?: string;
    userId?: string;
  };
  message?: {
    id?: string;
    type: string;
    text?: string;
    mention?: {
      mentionees?: Array<{
        isSelf?: boolean;
        [field: string]: unknown;
      }>;
    };
    [field: string]: unknown;
  };
  [field: string]: unknown;
}

export interface MentionedMessage {
  webhookEventId: string;
  replyToken: string;
  groupId: string;
  userId: string | null;
  messageId: string;
  text: string;
  timestamp: number;
}
