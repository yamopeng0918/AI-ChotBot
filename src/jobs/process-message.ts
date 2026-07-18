import type { AnswerService } from "../answers/types";
import { LineReplyError, type LineClient } from "../line/client";
import type { QuestionJob } from "./types";

export type ProcessResult = {
  status: "answered" | "provider_unavailable" | "reply_failed";
};

export type RecordedProcessResult = ProcessResult & {
  model: string | null;
};

export interface QuestionRecorder {
  record(job: QuestionJob, result: RecordedProcessResult): Promise<void>;
}

export interface ProcessDependencies {
  answerService: AnswerService;
  lineClient: Pick<LineClient, "reply">;
  recorder: QuestionRecorder;
}

export const PROVIDER_UNAVAILABLE_TEXT = "目前回答服務有點忙，請稍後再 @我 試一次。";

export async function processQuestion(
  job: QuestionJob,
  dependencies: ProcessDependencies,
): Promise<ProcessResult> {
  let text: string;
  let result: ProcessResult;
  let model: string | null;

  try {
    const answer = await dependencies.answerService.answer({ question: job.text, locale: "zh-TW" });
    text = answer.text;
    model = answer.model;
    result = { status: "answered" };
  } catch {
    text = PROVIDER_UNAVAILABLE_TEXT;
    model = null;
    result = { status: "provider_unavailable" };
  }

  try {
    await dependencies.lineClient.reply(job.replyToken, text);
  } catch (error) {
    if (error instanceof LineReplyError) {
      try {
        await dependencies.recorder.record(job, { status: "reply_failed", model });
      } finally {
        throw error;
      }
    }
    throw error;
  }

  await dependencies.recorder.record(job, { ...result, model });
  return result;
}
