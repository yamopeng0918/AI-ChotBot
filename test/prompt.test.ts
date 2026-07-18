import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../src/answers/prompt";

describe("buildSystemPrompt", () => {
  it("centralizes the language, persona, memory, and uncertainty policies", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toMatch(/繁體中文/);
    expect(prompt).toMatch(/友善/);
    expect(prompt).toMatch(/跑友/);
    expect(prompt).toMatch(/不要假設.*記憶|沒有.*記憶/);
    expect(prompt).toMatch(/不確定/);
    expect(prompt).toMatch(/不得捏造.*(?:引用|來源)/);
  });

  it("contains medical red-flag escalation and harmful-instruction refusal policies", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toMatch(/胸痛/);
    expect(prompt).toMatch(/呼吸困難/);
    expect(prompt).toMatch(/昏厥|失去意識/);
    expect(prompt).toMatch(/立即.*(?:就醫|急救)/);
    expect(prompt).toMatch(/拒絕.*(?:傷害|危險|違法)/);
  });
});
