export type RetrievalRouteInput = { question: string; insufficient: boolean; evidenceCount: number; topScore: number | null; evidence?: unknown };
export type RetrievalRoute = { searchWeb: boolean; reason: "explicit" | "time_sensitive" | "insufficient_knowledge" | "knowledge_sufficient" };

const explicit = /^(?:please\s+)?search\b|\b(?:can|could|would)\s+you\s+(?:search\b|look\s*up\b|check\s+online\b)|\b(?:search|check)\s+(?:the\s+)?(?:web|online)\b|\blook\s*up\b|(?:請|幫我|麻煩)?上網(?:查|搜)|^(?:請|幫我|麻煩)?(?:搜尋|查一下|查)/i;
const timely = /\b(?:latest|today|tomorrow|this\s+week|news|weather|price|exchange\s+rate|registration\s+deadline|upcoming\s+(?:event|race)|(?:event|race)\s+(?:schedule|registration|deadline)|current\s+(?:law|rules?|policy|president|prime\s+minister|ceo|version|release|status)|(?:law|rules?|policy|version|release|status)\s+(?:today|now|currently))\b|\b(?:what|which|when|where|how)\b.{0,60}\b(?:law|rules?|policy|schedule|events?|race)\b|\b(?:19|20)\d{2}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?\b|今天|明天|本週|下週|最新(?:版本|消息|新聞|狀態)?|目前(?:版本|狀態|價格|匯率)|現行(?:法規|法律|政策)|(?:天氣|價格|匯率|新聞)(?:今天|明天|目前)?|(?:活動|賽事).*(?:行程|報名|截止)|現任(?:總統|總理|執行長)/i;

export function decideRetrievalRoute(input: RetrievalRouteInput): RetrievalRoute {
  const question = input.question.trim();
  if (!question) throw new RangeError("question must not be empty");
  if (explicit.test(question)) return { searchWeb: true, reason: "explicit" };
  if (timely.test(question) || /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(question)) return { searchWeb: true, reason: "time_sensitive" };
  if (input.insufficient || input.evidenceCount < 1 || input.topScore === null || !Number.isFinite(input.topScore)) return { searchWeb: true, reason: "insufficient_knowledge" };
  return { searchWeb: false, reason: "knowledge_sufficient" };
}
