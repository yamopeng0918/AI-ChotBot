import type {
  AnswerProviderObserver,
  AnswerRequest,
  AnswerResult,
  AnswerService,
  AnswerStorageOperation,
} from "../answers/types";
import { extractWeatherLocationQuery, weatherLocationCandidates } from "../intents/router";
import type { WeatherCacheRepository } from "../storage/weather-cache";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type GeocodingResult = {
  results?: Array<{
    name?: string;
    admin1?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
    timezone?: string;
  }>;
};

type ForecastResult = {
  current?: {
    time?: string;
    temperature_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    precipitation?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    weather_code?: number[];
  };
};

const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

function reportCacheFailure(
  observe: AnswerProviderObserver | undefined,
  operation: AnswerStorageOperation,
): void {
  try {
    observe?.({ type: "storage.failed", provider: "open_meteo", operation });
  } catch {
    // Optional cache telemetry must not affect the weather answer.
  }
}

const WEATHER_DESCRIPTIONS: Record<number, string> = {
  0: "晴朗",
  1: "大致晴朗",
  2: "局部多雲",
  3: "陰天",
  45: "有霧",
  48: "結霧",
  51: "毛毛雨",
  53: "毛毛雨",
  55: "毛毛雨",
  56: "凍雨",
  57: "凍雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "凍雨",
  67: "凍雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "霰",
  80: "陣雨",
  81: "陣雨",
  82: "強陣雨",
  85: "陣雪",
  86: "強陣雪",
  95: "雷雨",
  96: "雷雨伴冰雹",
  99: "強雷雨伴冰雹",
};

function weatherDescription(code: number | undefined): string {
  if (typeof code !== "number") return "天氣未知";
  return WEATHER_DESCRIPTIONS[code] ?? `天氣代碼 ${code}`;
}

function formatDay(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatLocalTime(dateTime: string): string {
  return dateTime.match(/T(\d{2}:\d{2})/)?.[1] ?? "";
}

async function fetchJson<T>(fetcher: Fetcher, url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`weather provider responded ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedCacheKey(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-TW");
}

function formatResponse(locationLabel: string, forecast: ForecastResult): string {
  const current = forecast.current;
  const daily = forecast.daily;
  const lines: string[] = [];

  if (current) {
    const currentTime = current.time ? formatLocalTime(current.time) : "";
    lines.push(
      `${locationLabel}現在${currentTime ? `（${currentTime}）` : ""}：${typeof current.temperature_2m === "number" ? `${current.temperature_2m.toFixed(1)}°C` : "溫度未知"}，${weatherDescription(current.weather_code)}，風速 ${typeof current.wind_speed_10m === "number" ? `${current.wind_speed_10m.toFixed(1)} km/h` : "未知"}，降水 ${typeof current.precipitation === "number" ? `${current.precipitation.toFixed(1)} mm` : "未知"}。`,
    );
  }

  if (daily?.time?.length) {
    lines.push("接下來 3 天：");
    daily.time.slice(0, 3).forEach((date, index) => {
      const max = daily.temperature_2m_max?.[index];
      const min = daily.temperature_2m_min?.[index];
      const rain = daily.precipitation_sum?.[index];
      const code = daily.weather_code?.[index];
      lines.push(
        `- ${formatDay(date)}：${weatherDescription(code)}，${typeof max === "number" && typeof min === "number" ? `高 ${max.toFixed(1)}°C / 低 ${min.toFixed(1)}°C` : "溫度未知"}，降水 ${typeof rain === "number" ? `${rain.toFixed(1)} mm` : "未知"}`,
      );
    });
  }

  return lines.join("\n");
}

export class OpenMeteoWeatherService implements AnswerService {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly cache?: WeatherCacheRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async answer(
    request: AnswerRequest,
    observe?: AnswerProviderObserver,
  ): Promise<AnswerResult> {
    const cityQuery = extractWeatherLocationQuery(request.question) ?? request.defaultLocation?.trim() ?? null;
    if (!cityQuery) {
      return {
        text: "請直接告訴我城市，例如「台北天氣」或「查東京天氣」。",
        model: "open-meteo",
        inputTokens: null,
        outputTokens: null,
      };
    }

    const cacheKey = `weather:${normalizedCacheKey(cityQuery)}`;
    const now = this.now();
    let cached;
    try {
      cached = await this.cache?.get(cacheKey, now.toISOString());
    } catch {
      reportCacheFailure(observe, "cache_read");
    }
    if (cached) {
      return {
        text: cached.answerText,
        model: cached.model,
        inputTokens: null,
        outputTokens: null,
      };
    }

    let location: NonNullable<GeocodingResult["results"]>[number] | undefined;
    for (const candidate of weatherLocationCandidates(cityQuery)) {
      const geocoding = await fetchJson<GeocodingResult>(
        this.fetcher,
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=1&language=zh&format=json`,
      );
      const result = geocoding.results?.find((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
      if (result) {
        location = result;
        break;
      }
    }
    if (!location) {
      return {
        text: `找不到「${cityQuery}」的天氣地點，請改用更完整的城市名稱。`,
        model: "open-meteo",
        inputTokens: null,
        outputTokens: null,
      };
    }

    const timezone = typeof location.timezone === "string" && location.timezone ? location.timezone : "UTC";
    const forecast = await fetchJson<ForecastResult>(
      this.fetcher,
      `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=3&timezone=${encodeURIComponent(timezone)}`,
    );

    const labelParts = [location.name, location.admin1, location.country].filter((part): part is string => typeof part === "string" && part.length > 0);
    const locationLabel = labelParts.length > 0 ? `${labelParts.join(" / ")} ` : "";
    const text = formatResponse(locationLabel, forecast);

    try {
      await this.cache?.set({
        cacheKey,
        answerText: text,
        model: "open-meteo",
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
        createdAt: now.toISOString(),
      });
    } catch {
      reportCacheFailure(observe, "cache_write");
    }

    return {
      text,
      model: "open-meteo",
      inputTokens: null,
      outputTokens: null,
    };
  }
}
