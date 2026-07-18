import type { AnswerService } from "../answers/types";
import type { LineClient } from "../line/client";
import type { QuestionJob } from "./types";

export type ProcessResult = {
  status: "answered" | "provider_unavailable" | "reply_failed";
};

export interface QuestionRecorder {
  record(job: QuestionJob, result: ProcessResult): Promise<void>;
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

  try {
    const answer = await dependencies.answerService.answer({ question: job.text, locale: "zh-TW" });
    text = answer.text;
    result = { status: "answered" };
  } catch {
    text = PROVIDER_UNAVAILABLE_TEXT;
    result = { status: "provider_unavailable" };
  }

  await dependencies.lineClient.reply(job.replyToken, text);
  await dependencies.recorder.record(job, result);
  return result;
}
