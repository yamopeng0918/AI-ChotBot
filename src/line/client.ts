export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const MAX_TEXT_CODE_POINTS = 4_500;
const TRUNCATION_SUFFIX = "…";

export class LineReplyError extends Error {
  constructor(readonly status: number | null = null) {
    super(status === null ? "LINE reply failed" : `LINE reply failed (${status})`);
    this.name = "LineReplyError";
  }
}

function truncateText(text: string): string {
  const codePoints = [...text];
  if (codePoints.length <= MAX_TEXT_CODE_POINTS) return text;
  return codePoints.slice(0, MAX_TEXT_CODE_POINTS - [...TRUNCATION_SUFFIX].length).join("")
    + TRUNCATION_SUFFIX;
}

export class LineClient {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly accessToken: string,
  ) {}

  async reply(replyToken: string, text: string): Promise<void> {
    if (!text.trim()) throw new LineReplyError();

    let response: Response;
    try {
      response = await this.fetcher(REPLY_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          replyToken,
          messages: [{ type: "text", text: truncateText(text) }],
        }),
      });
    } catch {
      throw new LineReplyError();
    }

    if (!response.ok) throw new LineReplyError(response.status);
  }
}
