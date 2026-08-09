import { describe, expect, it } from "vitest";

import { classifyIntent, extractWeatherLocationQuery, weatherLocationCandidates } from "../src/intents/router";

describe("intent router", () => {
  it("detects weather intent", () => {
    expect(classifyIntent("今天台北天氣如何？")).toBe("weather");
    expect(classifyIntent("請幫我查東京 weather")).toBe("weather");
    expect(classifyIntent("今天跑步菜單怎麼排")).toBe("general");
  });

  it("extracts a city query from common weather prompts", () => {
    expect(extractWeatherLocationQuery("今天台北天氣如何？")).toBe("台北");
    expect(extractWeatherLocationQuery("請幫我查東京天氣")).toBe("東京");
    expect(extractWeatherLocationQuery("weather Singapore")).toBe("Singapore");
  });

  it.each([
    "請問斗六市明天適合跑步嗎？",
    "台北今天適合去跑步嗎？",
    "新北市明早能不能跑步？",
    "高雄後天可以跑步嗎？",
    "東京週末跑步適合嗎？",
  ])("recognizes time-specific running suitability as weather: %s", (question) => {
    expect(classifyIntent(question)).toBe("weather");
  });

  it.each(["我適合跑步嗎？", "如何開始跑步？", "新手本週跑量怎麼安排？"])("keeps general running advice out of weather: %s", (question) => {
    expect(classifyIntent(question)).toBe("general");
  });

  it.each([
    "本週適合跑步的訓練菜單怎麼安排？",
    "明天適合跑步的課表怎麼排？",
    "本週適合跑步的跑量是多少？",
  ])("keeps time-specific training plans out of weather: %s", (question) => {
    expect(classifyIntent(question)).toBe("general");
  });

  it("keeps training background weather questions in weather", () => {
    expect(classifyIntent("我正在馬拉松訓練，台北明天適合跑步嗎？")).toBe("weather");
  });

  it("extracts only the city from contextual running weather", () => {
    expect(extractWeatherLocationQuery("請問斗六市明天適合跑步嗎？")).toBe("斗六市");
    expect(extractWeatherLocationQuery("台北今天適合去跑步嗎？")).toBe("台北");
    expect(extractWeatherLocationQuery("新北市明早能不能跑步？")).toBe("新北市");
    expect(extractWeatherLocationQuery("高雄後天可以跑步嗎？")).toBe("高雄");
    expect(extractWeatherLocationQuery("東京週末跑步適合嗎？")).toBe("東京");
    expect(extractWeatherLocationQuery("明天適合跑步嗎？")).toBeNull();
  });

  it("builds at most two deduplicated geocoding candidates", () => {
    expect(weatherLocationCandidates("斗六市")).toEqual(["斗六市", "斗六"]);
    expect(weatherLocationCandidates("新北市")).toEqual(["新北市", "新北"]);
    expect(weatherLocationCandidates("高雄")).toEqual(["高雄"]);
    expect(weatherLocationCandidates("東京")).toEqual(["東京"]);
    expect(weatherLocationCandidates("Singapore")).toEqual(["Singapore"]);
    expect(weatherLocationCandidates(" 市 ")).toEqual(["市"]);
    expect(weatherLocationCandidates("   ")).toEqual([]);
  });
});
