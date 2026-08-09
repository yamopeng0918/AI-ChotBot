const WEATHER_KEYWORDS = /(?:天氣|氣象|氣溫|溫度|下雨|降雨|weather|rain|forecast)/i;
const WEATHER_TIME_SIGNALS = /(?:今天|今晚|明天|明早|明晚|後天|本週|週末|現在|目前)/i;
const RUNNING_SUITABILITY = /(?:適合(?:去)?(?:跑步|跑)|適不適合(?:跑步|跑)|可以(?:去)?跑步嗎|能不能(?:去)?跑步|跑步適合嗎)/i;
const ADMINISTRATIVE_LOCATION = /[\p{Script=Han}]{2,8}(?:縣|市|區|鄉|鎮)/u;
const WHOLE_HAN_LOCATION = /^[\p{Script=Han}]{2,8}$/u;
const WHOLE_LETTER_LOCATION = /^[\p{L}][\p{L} .'-]{1,39}$/u;

const LOCATION_STOP_WORDS = [
  /@[^ \n]+/gu,
  /(?:請問|請幫我|幫我|麻煩|想問|查詢|查看|查|看一下|看看)/gu,
  /(?:今天|今晚|明天|明早|明晚|後天|本週|週末|現在|目前)/gu,
  /(?:適不適合(?:跑步|跑)|適合(?:去)?(?:跑步|跑)|可以(?:去)?跑步嗎|能不能(?:去)?跑步|跑步適合嗎)/gu,
  /(?:天氣|氣象|氣溫|溫度|下雨|降雨)/gu,
  /(?:跑步|慢跑)/gu,
  /(?:適合|可以|能不能)/gu,
  /(?:如何|怎麼樣|怎樣|好嗎|嗎|呢|一下|的)/gu,
  /\b(?:weather|rain|forecast|please|check|in|at|for|today|tomorrow|now)\b/giu,
  /[？?！!，,。；;：:]/gu,
];

export type RoutedIntent = "weather" | "general";

export function classifyIntent(text: string): RoutedIntent {
  return WEATHER_KEYWORDS.test(text) || (WEATHER_TIME_SIGNALS.test(text) && RUNNING_SUITABILITY.test(text))
    ? "weather"
    : "general";
}

export function extractWeatherLocationQuery(text: string): string | null {
  if (classifyIntent(text) !== "weather") return null;

  const cleaned = LOCATION_STOP_WORDS.reduce((value, pattern) => value.replace(pattern, " "), text)
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;

  const administrative = cleaned.match(ADMINISTRATIVE_LOCATION);
  if (administrative && cleaned.replace(administrative[0], "").trim().length === 0) return administrative[0];
  return WHOLE_HAN_LOCATION.test(cleaned) || WHOLE_LETTER_LOCATION.test(cleaned) ? cleaned : null;
}

export function weatherLocationCandidates(location: string): string[] {
  const exact = location.trim();
  if (!exact) return [];
  const candidates = [exact];
  const withoutSuffix = exact.replace(/[縣市區鄉鎮]$/u, "").trim();
  if (withoutSuffix) candidates.push(withoutSuffix);
  return [...new Set(candidates)].slice(0, 2);
}
