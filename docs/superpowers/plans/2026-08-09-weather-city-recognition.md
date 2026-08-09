# Weather City Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route time-specific running-suitability questions to weather and resolve bounded city-name candidates such as `斗六市` then `斗六`.

**Architecture:** Keep explicit weather keywords, add a narrow time-plus-running-suitability classifier, and replace broad residual text with deterministic city extraction. Open-Meteo tries at most two server-derived, deduplicated geocoding candidates before forecasting, while cache, telemetry, and public answer interfaces remain unchanged.

**Tech Stack:** TypeScript, Cloudflare Workers, Open-Meteo Geocoding/Forecast APIs, D1 weather cache, Vitest, Wrangler.

## Global Constraints

- Do not use an LLM for intent or city extraction.
- Contextual weather requires both a supported time signal and a running-suitability signal.
- `我適合跑步嗎？` and generic training questions remain `general`.
- Never send the full original question to Open-Meteo geocoding.
- Geocoding receives at most two unique candidates: exact city, then one administrative suffix removed.
- Stop after the first result with finite latitude and longitude.
- Do not log question or city text.
- Preserve default-city, cache, forecast, admin, knowledge, and draft behavior.

---

## File structure

- Modify `src/intents/router.ts`: contextual weather classification, deterministic primary city extraction, and bounded suffix fallback candidates.
- Modify `test/intents.test.ts`: classification/extraction/candidate matrices and false-positive locks.
- Modify `src/weather/openmeteo.ts`: sequential bounded geocoding candidate lookup.
- Modify `test/weather.test.ts`: exact/fallback/no-result/default/cache behavior.
- Modify `test/process-message.test.ts`: prove the reported Douliu question selects weather service and bypasses general answering.

### Task 1: Classify running-suitability weather and extract city candidates

**Files:**
- Modify: `src/intents/router.ts`
- Modify: `test/intents.test.ts`

**Interfaces:**
- Preserves: `classifyIntent(text: string): "weather" | "general"`.
- Preserves: `extractWeatherLocationQuery(text: string): string | null`.
- Adds: `weatherLocationCandidates(location: string): string[]`.

- [ ] **Step 1: Write RED intent tests**

Add exact assertions:

```ts
expect(classifyIntent("請問斗六市明天適合跑步嗎？")).toBe("weather");
expect(classifyIntent("明天適合跑步嗎？")).toBe("weather");
expect(classifyIntent("我適合跑步嗎？")).toBe("general");
expect(classifyIntent("如何開始跑步？")).toBe("general");
```

Also cover 今天、明早、後天、週末 with supported suitability phrases.

- [ ] **Step 2: Write RED extraction and fallback tests**

```ts
expect(extractWeatherLocationQuery("請問斗六市明天適合跑步嗎？")).toBe("斗六市");
expect(extractWeatherLocationQuery("明天適合跑步嗎？")).toBeNull();
expect(weatherLocationCandidates("斗六市")).toEqual(["斗六市", "斗六"]);
expect(weatherLocationCandidates("新北市")).toEqual(["新北市", "新北"]);
expect(weatherLocationCandidates("高雄")).toEqual(["高雄"]);
expect(weatherLocationCandidates("Singapore")).toEqual(["Singapore"]);
```

Retain Taipei/Tokyo/English explicit-weather assertions and add a multiple-residual-words case that returns `null` instead of guessing.

- [ ] **Step 3: Run RED**

```powershell
npm.cmd test -- test/intents.test.ts
```

Expected: Douliu classification/extraction and `weatherLocationCandidates` fail because current code requires explicit weather keywords and has no fallback API.

- [ ] **Step 4: Implement narrow contextual weather detection**

Create separate Unicode regex constants for supported time signals and running-suitability signals. `classifyIntent` returns weather when explicit keywords match or both contextual regexes match. `extractWeatherLocationQuery` calls `classifyIntent`, then removes existing weather words plus polite/action, time, suitability, running, and punctuation tokens.

- [ ] **Step 5: Implement safe primary extraction and candidates**

After cleaning, prefer a single `/[\p{Script=Han}]{2,8}(?:縣|市|區|鄉|鎮)/u` administrative match. Otherwise accept only an entire clean value matching a bounded Han city or bounded Unicode letter city. `weatherLocationCandidates` trims input, appends the exact value, optionally removes one final `縣|市|區|鄉|鎮`, filters empty values, deduplicates, and slices to two.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm.cmd test -- test/intents.test.ts
git add src/intents/router.ts test/intents.test.ts
git commit -m "fix: recognize running weather locations"
```

### Task 2: Try bounded geocoding aliases

**Files:**
- Modify: `src/weather/openmeteo.ts`
- Modify: `test/weather.test.ts`

**Interfaces:**
- Consumes: `weatherLocationCandidates(cityQuery): string[]`.
- Preserves: `OpenMeteoWeatherService.answer(request, observe)` and `AnswerResult`.

- [ ] **Step 1: Write RED exact-candidate success test**

For `斗六市`, return a valid first geocoding result. Assert one geocoding call whose decoded `name` is `斗六市`, one forecast call, and no `斗六` request.

- [ ] **Step 2: Write RED suffix-fallback test**

Return `{ results: [] }` for `斗六市`, a finite Douliu result for `斗六`, then a forecast. Assert geocoding names equal `["斗六市", "斗六"]`, forecast is called once, and the result model is `open-meteo`.

- [ ] **Step 3: Write RED exhaustion and invalid-coordinate tests**

Return empty or non-finite coordinates for both candidates. Assert two geocoding calls, no forecast call, and the safe not-found response. Add a default location `斗六市` case using the same fallback.

- [ ] **Step 4: Run RED**

```powershell
npm.cmd test -- test/weather.test.ts
```

Expected: fallback assertions fail because current service calls geocoding once with only `cityQuery`.

- [ ] **Step 5: Implement sequential bounded lookup**

Import `weatherLocationCandidates`. Iterate candidates, call the unchanged geocoding URL with each candidate, and accept only a result for which `Number.isFinite(latitude)` and `Number.isFinite(longitude)` are true. Break immediately on success. Keep cache key based on primary `cityQuery`; do not change forecast formatting or cache telemetry.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm.cmd test -- test/intents.test.ts test/weather.test.ts
npm.cmd run typecheck
git add src/weather/openmeteo.ts test/weather.test.ts
git commit -m "fix: retry weather geocoding with city alias"
```

### Task 3: Lock end-to-end routing and privacy behavior

**Files:**
- Modify: `test/process-message.test.ts`
- Verify: `test/logger.test.ts`

**Interfaces:**
- Consumes the unchanged process-message weather service boundary.
- Produces regression proof that the reported question never reaches general/knowledge answering.

- [ ] **Step 1: Write process routing test**

Send `請問斗六市明天適合跑步嗎？`. Assert weather service is called once with the original request and locale/default-location fields, general answer service/retriever/web search/grounded service are not called, the LINE reply uses the weather answer, and metrics/telemetry classify `intent: "weather"` without city fields.

- [ ] **Step 2: Run focused integration tests**

```powershell
npm.cmd test -- test/process-message.test.ts test/logger.test.ts test/intents.test.ts test/weather.test.ts
```

Expected: all pass after Tasks 1-2; the new process test is a regression lock over real `classifyIntent` routing.

- [ ] **Step 3: Commit integration coverage**

```powershell
git add test/process-message.test.ts
git commit -m "test: lock contextual weather routing"
```

### Task 4: Verify, review, deploy, and smoke

**Files:**
- Verify all commits after `0421ce7`.
- Do not add content-bearing telemetry or diagnostic routes.

- [ ] **Step 1: Run fresh local verification**

```powershell
npm.cmd test
npm.cmd run typecheck
git diff --check
npx.cmd wrangler deploy --dry-run
```

Expected: all tests pass; bindings remain Queue, D1, Vectorize, R2, and AI; no unrelated files change.

- [ ] **Step 2: Obtain independent review**

Review against `docs/superpowers/specs/2026-08-09-weather-city-recognition-design.md`. Block deployment for broad false-positive weather classification, full-question geocoding, more than two candidates, infinite coordinates, city-bearing telemetry, cache-key regressions, or changes to non-weather flows.

- [ ] **Step 3: Deploy and health-check**

```powershell
npx.cmd wrangler deploy
Invoke-WebRequest -Uri 'https://line-running-community-bot.yamolineaichotbot.workers.dev/health' -UseBasicParsing
```

Expected: new Version ID and HTTP 200 `{"status":"ok"}`.

- [ ] **Step 4: Run metadata-only production smoke**

Start exactly one `wrangler tail`. Ask the user to resend `請問斗六市明天適合跑步嗎？`. Success requires `intent=weather`, model `open-meteo`, successful LINE reply, no grounded provider events, and no city/question text in telemetry.

- [ ] **Step 5: Stop tail and report**

Always stop the exact tail process chain. Report Version ID, intent, provider model, LINE/Queue outcome, and whether general grounding was bypassed. Do not reproduce question, city, geocoding URL, coordinates, provider payload, or LINE identifiers.
