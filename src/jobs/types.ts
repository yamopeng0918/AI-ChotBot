import type { MentionedMessage } from "../line/types";

export interface QuestionJob extends MentionedMessage {
  receivedAt: string;
}
