const WEATHER_KEYWORDS = /(?:天氣|氣象|氣溫|溫度|下雨|降雨|weather|rain|forecast)/i;

const WEATHER_STOP_WORDS = [
  /@[^ \n]+/g,
  /請問/g,
  /請/g,
  /幫我/g,
  /幫忙/g,
  /查詢/g,
  /查/g,
  /看/g,
  /一下/g,
  /現在/g,
  /今天/g,
  /明天/g,
  /後天/g,
  /這週/g,
  /本週/g,
  /最近/g,
  /的/g,
  /天氣/g,
  /氣象/g,
  /氣溫/g,
  /溫度/g,
  /下雨/g,
  /降雨/g,
  /weather/g,
  /rain/g,
  /forecast/g,
  /如何/g,
  /怎麼樣/g,
  /怎樣/g,
  /會不會/g,
  /嗎/g,
  /呢/g,
  /吧/g,
  /？/g,
  /\?/g,
  /！/g,
  /!/g,
  /，/g,
  /,/g,
  /。/g,
  /：/g,
  /:/g,
];

export type RoutedIntent = "weather" | "general";

export function classifyIntent(text: string): RoutedIntent {
  return WEATHER_KEYWORDS.test(text) ? "weather" : "general";
}

export function extractWeatherLocationQuery(text: string): string | null {
  if (!WEATHER_KEYWORDS.test(text)) return null;

  const cleaned = WEATHER_STOP_WORDS.reduce((value, pattern) => value.replace(pattern, " "), text)
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}
