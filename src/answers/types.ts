export interface AnswerRequest {
  question: string;
  locale: "zh-TW";
  groupId?: string;
  defaultLocation?: string | null;
}

export interface AnswerResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AnswerService {
  answer(request: AnswerRequest): Promise<AnswerResult>;
}
