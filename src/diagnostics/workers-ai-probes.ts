import {
  WORKERS_AI_GROUNDED_MODEL,
  WORKERS_AI_GROUNDED_RESPONSE_FORMAT,
  workersAiDiagnosticCategory,
  type WorkersAiDiagnosticCategory,
} from "../answers/grounded-generators";

export interface WorkersAiProbeBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
export type WorkersAiProbeName = "baseline" | "simple_json" | "grounded_schema";
export type WorkersAiProbeResult =
  | { name: WorkersAiProbeName; outcome: "success" }
  | { name: WorkersAiProbeName; outcome: "failed"; diagnosticCategory: WorkersAiDiagnosticCategory };
export type WorkersAiProbeReport = { probes: WorkersAiProbeResult[] };
export interface WorkersAiProbeRunner {
  run(): Promise<WorkersAiProbeReport>;
}

const SIMPLE_JSON_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: { status: { type: "string", enum: ["ok"] } },
  },
} as const;

const PROBES: ReadonlyArray<{ name: WorkersAiProbeName; input: Record<string, unknown> }> = [
  {
    name: "baseline",
    input: {
      messages: [{ role: "user", content: "Reply with OK." }],
      temperature: 0,
      max_tokens: 32,
    },
  },
  {
    name: "simple_json",
    input: {
      messages: [{ role: "user", content: "Return status ok using the required JSON schema." }],
      temperature: 0,
      max_tokens: 64,
      response_format: SIMPLE_JSON_RESPONSE_FORMAT,
    },
  },
  {
    name: "grounded_schema",
    input: {
      messages: [
        {
          role: "system",
          content: "Use the exact fixed evidence sentence as answer and claim text. Cite only evidence ID e1.",
        },
        { role: "user", content: "Evidence e1: Running is exercise." },
      ],
      temperature: 0,
      max_tokens: 128,
      response_format: WORKERS_AI_GROUNDED_RESPONSE_FORMAT,
    },
  },
];

export async function runWorkersAiProbes(ai: WorkersAiProbeBinding): Promise<WorkersAiProbeReport> {
  const probes: WorkersAiProbeResult[] = [];
  for (const probe of PROBES) {
    try {
      await ai.run(WORKERS_AI_GROUNDED_MODEL, probe.input);
      probes.push({ name: probe.name, outcome: "success" });
    } catch (error) {
      probes.push({
        name: probe.name,
        outcome: "failed",
        diagnosticCategory: workersAiDiagnosticCategory(error),
      });
    }
  }
  return { probes };
}
