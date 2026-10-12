/**
 * The intent compiler: a recorded demonstration in, a parameterized workflow out.
 *
 * The model is injected rather than constructed, so the whole pipeline — prompt
 * assembly, parsing, every validation, the repair loop — is testable against
 * golden fixtures with no API key and no network. The key gates exactly one
 * function call, which is where it should be: the bugs live in the validation,
 * not in the HTTP.
 */

import type { IntentLink, Trace } from "@intentlink/schema";
import { RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, buildUserPrompt } from "./prompt.js";
import {
  CompilationError,
  toIntentLink,
  type RawCompilation,
  type ValidationContext,
} from "./parse.js";

/** Minimal surface we need from a model. Keeps @google/genai out of tests. */
export interface ModelClient {
  generate(request: {
    systemInstruction: string;
    prompt: string;
    responseSchema: unknown;
  }): Promise<string>;
}

export interface CompileOptions extends Omit<ValidationContext, "trace"> {
  /** Repair attempts after the first failure. Each costs a round trip. */
  maxRepairs?: number;
  /** Observes each attempt; used by the creator UI to show the model's work. */
  onAttempt?: (attempt: number, problems: string[]) => void;
}

export interface CompileResult {
  intent: IntentLink;
  /** How many model calls it took. Surfaced so a flaky prompt is visible. */
  attempts: number;
  raw: RawCompilation;
}

export async function compileIntent(
  model: ModelClient,
  trace: Trace,
  opts: CompileOptions,
): Promise<CompileResult> {
  const maxRepairs = opts.maxRepairs ?? 2;
  let prompt = buildUserPrompt(trace);
  let lastProblems: string[] = [];

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const text = await model.generate({
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt,
      responseSchema: RESPONSE_SCHEMA,
    });

    let raw: RawCompilation;
    try {
      raw = parseJson(text);
    } catch (err) {
      lastProblems = [err instanceof Error ? err.message : "response was not JSON"];
      opts.onAttempt?.(attempt, lastProblems);
      prompt = repairPrompt(trace, lastProblems);
      continue;
    }

    try {
      const intent = toIntentLink(raw, { ...opts, trace });
      opts.onAttempt?.(attempt, []);
      return { intent, attempts: attempt, raw };
    } catch (err) {
      if (!(err instanceof CompilationError)) throw err;
      lastProblems = err.problems;
      opts.onAttempt?.(attempt, lastProblems);
      prompt = repairPrompt(trace, lastProblems);
    }
  }

  throw new CompilationError(
    `could not compile after ${maxRepairs + 1} attempts`,
    lastProblems,
  );
}

/**
 * Re-send the whole trace rather than only the complaints.
 *
 * A repair prompt carrying just the problems invites the model to patch its
 * previous answer from memory, and the fixes drift away from what was actually
 * demonstrated — which is precisely what the validations are guarding.
 */
function repairPrompt(trace: Trace, problems: string[]): string {
  return [
    "Your previous compilation was rejected. Fix every problem listed and",
    "return a complete compilation — not a patch.",
    "",
    "PROBLEMS",
    ...problems.map((p) => `  - ${p}`),
    "",
    "Remember: literals must be values that actually appear in the recording,",
    "verbs are semantic and snake_case, every step cites the events it came",
    "from, and anything derived from a redacted event must be a parameter.",
    "",
    buildUserPrompt(trace),
  ].join("\n");
}

/** Models sometimes wrap JSON in prose or a fence despite a response schema. */
export function parseJson(text: string): RawCompilation {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as RawCompilation;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.steps)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  throw new Error("model response did not contain a usable JSON object");
}

/* ----------------------------- the real client ---------------------------- */

/**
 * Gemini-backed client. Compile-time reasoning runs once per IntentLink and
 * quality matters far more than latency, so this should point at a Pro-tier
 * model while the run-time resolver uses a Flash-tier one.
 */
export function geminiClient(options?: {
  apiKey?: string;
  model?: string;
}): ModelClient {
  return {
    async generate({ systemInstruction, prompt, responseSchema }) {
      const apiKey = options?.apiKey ?? process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "GOOGLE_API_KEY is not set. Put it in .env (gitignored) or Secret Manager.",
        );
      }
      const model =
        options?.model ?? process.env.INTENTLINK_MODEL_COMPILE;
      if (!model) {
        throw new Error(
          "INTENTLINK_MODEL_COMPILE is not set. Pick a current Pro-tier Gemini model.",
        );
      }

      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: responseSchema as never,
          // Compilation is a judgment we want to be reproducible for the same
          // recording; creativity here shows up as a workflow that drifts
          // between runs of the same input.
          temperature: 0.1,
        },
      });

      const text = response.text;
      if (!text) throw new Error("Gemini returned an empty response");
      return text;
    },
  };
}
