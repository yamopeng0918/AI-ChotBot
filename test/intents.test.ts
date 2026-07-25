import { describe, expect, it } from "vitest";

import { classifyIntent, extractWeatherLocationQuery } from "../src/intents/router";

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
});
