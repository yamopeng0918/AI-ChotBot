export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const MAX_TEXT_CODE_POINTS = 4_500;
const TRUNCATION_SUFFIX = "…";

export class LineReplyError extends Error {
  constructor(readonly status: number | null = null, readonly causeMessage: string | null = null, readonly endpoint: string | null = null) {
    super(status === null ? "LINE reply failed" : `LINE reply failed (${status})`);
    this.name = "LineReplyError";
  }
}

function truncateText(text: string): string {
  const codePoints = [...text];
  if (codePoints.length <= MAX_TEXT_CODE_POINTS) return text;
  return codePoints.slice(0, MAX_TEXT_CODE_POINTS - [...TRUNCATION_SUFFIX].length).join("") + TRUNCATION_SUFFIX;
}

function messageBody(targetKey: "replyToken" | "to", targetValue: string, text: string): string {
  return JSON.stringify({
    [targetKey]: targetValue,
    messages: [{ type: "text", text: truncateText(text) }],
  });
}

export class LineClient {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly accessToken: string,
  ) {}

  async reply(replyToken: string, text: string): Promise<void> {
    if (!text.trim()) throw new LineReplyError();
    await this.send(REPLY_ENDPOINT, messageBody("replyToken", replyToken, text));
  }

  async push(to: string, text: string): Promise<void> {
    if (!text.trim()) throw new LineReplyError();
    await this.send(PUSH_ENDPOINT, messageBody("to", to, text));
  }

  private async send(endpoint: string, body: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (error) {
      throw new LineReplyError(null, error instanceof Error ? error.message : String(error), endpoint);
    }

    if (!response.ok) throw new LineReplyError(response.status);
  }
}
