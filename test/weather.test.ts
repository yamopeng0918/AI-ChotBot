import { describe, expect, it, vi } from "vitest";

import type { AnswerProviderEvent } from "../src/answers/types";
import { OpenMeteoWeatherService } from "../src/weather/openmeteo";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulTaipeiFetcher() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("geocoding-api.open-meteo.com")) {
      return jsonResponse({
        results: [{
          name: "Taipei",
          country: "Taiwan",
          latitude: 25.033,
          longitude: 121.5654,
          timezone: "Asia/Taipei",
        }],
      });
    }
    return jsonResponse({
      current: {
        temperature_2m: 31.2,
        weather_code: 1,
        wind_speed_10m: 12.3,
        precipitation: 0,
      },
      daily: {
        time: ["2026-07-25"],
        temperature_2m_max: [32],
        temperature_2m_min: [26],
        precipitation_sum: [0],
        weather_code: [1],
      },
    });
  });
}

describe("OpenMeteoWeatherService", () => {
  it("returns a city forecast from geocoding and forecast endpoints", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return jsonResponse({
          results: [
            {
              name: "Taipei",
              admin1: "Taipei",
              country: "Taiwan",
              latitude: 25.033,
              longitude: 121.5654,
              timezone: "America/New_York",
            },
          ],
        });
      }
      if (url.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: { time: "2026-07-25T08:00", temperature_2m: 31.2, weather_code: 1, wind_speed_10m: 12.3, precipitation: 0 },
          daily: {
            time: ["2026-07-25", "2026-07-26", "2026-07-27"],
            temperature_2m_max: [32.1, 31.4, 30.8],
            temperature_2m_min: [26.5, 26.1, 25.9],
            precipitation_sum: [0, 1.2, 4.5],
            weather_code: [1, 3, 61],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const service = new OpenMeteoWeatherService(fetcher);
    const answer = await service.answer({ question: "今天台北天氣如何？", locale: "zh-TW" });
    expect(answer).toMatchObject({
      model: "open-meteo",
      inputTokens: null,
      outputTokens: null,
      text: expect.stringContaining("Taipei / Taipei / Taiwan"),
    });
    expect(answer.text).toContain("（08:00）");
    expect(answer.text).toContain("7/25");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries geocoding once without the administrative suffix", async () => {
    const geocodingNames: string[] = [];
    let forecastCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "geocoding-api.open-meteo.com") {
        const name = url.searchParams.get("name") ?? "";
        geocodingNames.push(name);
        if (name === "斗六市") return jsonResponse({ results: [] });
        return jsonResponse({ results: [{ name: "Douliu", country: "Taiwan", latitude: 23.71, longitude: 120.54, timezone: "Asia/Taipei" }] });
      }
      forecastCalls += 1;
      return jsonResponse({
        current: { temperature_2m: 27, weather_code: 1, wind_speed_10m: 8, precipitation: 0 },
        daily: { time: ["2026-08-09"], temperature_2m_max: [30], temperature_2m_min: [24], precipitation_sum: [0], weather_code: [1] },
      });
    });

    const answer = await new OpenMeteoWeatherService(fetcher)
      .answer({ question: "請問斗六市明天適合跑步嗎？", locale: "zh-TW" });

    expect(geocodingNames).toEqual(["斗六市", "斗六"]);
    expect(forecastCalls).toBe(1);
    expect(answer.model).toBe("open-meteo");
    expect(answer.text).toContain("Douliu / Taiwan");
  });

  it("stops after two invalid geocoding candidates without calling forecast", async () => {
    const geocodingNames: string[] = [];
    let forecastCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "geocoding-api.open-meteo.com") {
        const name = url.searchParams.get("name") ?? "";
        geocodingNames.push(name);
        return name === "斗六市"
          ? jsonResponse({ results: [{ name, latitude: Number.NaN, longitude: 120.54 }] })
          : jsonResponse({ results: [] });
      }
      forecastCalls += 1;
      return jsonResponse({});
    });

    const answer = await new OpenMeteoWeatherService(fetcher)
      .answer({ question: "請問斗六市明天適合跑步嗎？", locale: "zh-TW" });

    expect(geocodingNames).toEqual(["斗六市", "斗六"]);
    expect(forecastCalls).toBe(0);
    expect(answer.text).toContain("找不到");
  });

  it("uses the default location when the prompt lacks a city", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return jsonResponse({
          results: [
            {
              name: "Tokyo",
              country: "Japan",
              latitude: 35.6762,
              longitude: 139.6503,
              timezone: "Asia/Tokyo",
            },
          ],
        });
      }
      if (url.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: { temperature_2m: 28.5, weather_code: 2, wind_speed_10m: 8.2, precipitation: 0 },
          daily: { time: ["2026-07-25"], temperature_2m_max: [30], temperature_2m_min: [24], precipitation_sum: [0], weather_code: [2] },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const service = new OpenMeteoWeatherService(fetcher);
    await expect(
      service.answer({ question: "今天的天氣怎麼樣？", locale: "zh-TW", defaultLocation: "東京" }),
    ).resolves.toMatchObject({ text: expect.stringContaining("Tokyo / Japan") });
  });

  it("caches repeated lookups for the same city", async () => {
    const store = new Map<string, { answerText: string; model: string; expiresAt: string; createdAt: string }>();
    const cache = {
      get: vi.fn(async (cacheKey: string) => store.get(cacheKey) ?? null),
      set: vi.fn(async (record: { cacheKey: string; answerText: string; model: string; expiresAt: string; createdAt: string }) => {
        store.set(record.cacheKey, record);
      }),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return jsonResponse({
          results: [
            {
              name: "Taipei",
              country: "Taiwan",
              latitude: 25.033,
              longitude: 121.5654,
              timezone: "Asia/Taipei",
            },
          ],
        });
      }
      return jsonResponse({
        current: { temperature_2m: 31.2, weather_code: 1, wind_speed_10m: 12.3, precipitation: 0 },
        daily: { time: ["2026-07-25"], temperature_2m_max: [32], temperature_2m_min: [26], precipitation_sum: [0], weather_code: [1] },
      });
    });

    const service = new OpenMeteoWeatherService(fetcher, cache as never, () => new Date("2026-07-25T08:00:00.000Z"));
    await service.answer({ question: "台北天氣", locale: "zh-TW" });
    await service.answer({ question: "台北天氣", locale: "zh-TW" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("continues to Open-Meteo after a cache-read failure and reports safe storage telemetry", async () => {
    const cache = {
      get: vi.fn().mockRejectedValue(new Error("D1 cache read credentials=private")),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const fetcher = successfulTaipeiFetcher();
    const service = new OpenMeteoWeatherService(fetcher, cache as never);
    const observations: AnswerProviderEvent[] = [];

    await expect(
      service.answer(
        { question: "Taipei weather", locale: "zh-TW" },
        (event) => observations.push(event),
      ),
    ).resolves.toMatchObject({
      model: "open-meteo",
      text: expect.stringContaining("Taipei / Taiwan"),
    });
    expect(observations).toEqual([{
      type: "storage.failed",
      provider: "open_meteo",
      operation: "cache_read",
    }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(observations)).not.toContain("credentials=private");
  });

  it("returns the valid provider answer after a cache-write failure and reports safe storage telemetry", async () => {
    const cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error("D1 cache write credentials=private")),
    };
    const fetcher = successfulTaipeiFetcher();
    const service = new OpenMeteoWeatherService(fetcher, cache as never);
    const observations: AnswerProviderEvent[] = [];

    await expect(
      service.answer(
        { question: "Taipei weather", locale: "zh-TW" },
        (event) => observations.push(event),
      ),
    ).resolves.toMatchObject({
      model: "open-meteo",
      text: expect.stringContaining("Taipei / Taiwan"),
    });
    expect(observations).toEqual([{
      type: "storage.failed",
      provider: "open_meteo",
      operation: "cache_write",
    }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(observations)).not.toContain("credentials=private");
  });

  it("asks for a city when the prompt lacks one", async () => {
    const service = new OpenMeteoWeatherService(vi.fn());
    await expect(service.answer({ question: "天氣怎麼樣？", locale: "zh-TW" })).resolves.toMatchObject({
      text: expect.stringContaining("請直接告訴我城市"),
    });
  });
});
