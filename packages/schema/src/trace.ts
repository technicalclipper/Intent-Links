import { z } from "zod";
import { ElementDescriptor, PageContext } from "./descriptor.js";

/**
 * Trace — what the recorder produces.
 *
 * A trace is evidence, not a program. It is never executed directly; the intent
 * compiler turns it into a semantic workflow (see intent.ts). Keeping these
 * separate is what makes IntentLink adaptive rather than a macro recorder.
 */

export const TraceEventType = z.enum([
  "click",
  "fill",
  "select",
  "toggle",
  "check",
  "keypress",
  "submit",
  "navigate",
  "wait",
]);
export type TraceEventType = z.infer<typeof TraceEventType>;

/** Why a captured value was withheld. Redaction runs before persistence. */
export const RedactionReason = z.enum([
  "secret",
  "credential",
  "token",
  "email",
  "phone",
  "card",
  "government_id",
  "manual",
]);

export const TraceEvent = z
  .object({
    seq: z.number().int().min(0),
    /** ms since recording start. */
    t: z.number().int().min(0),
    type: TraceEventType,
    page: PageContext,
    target: ElementDescriptor.optional(),

    /** Value the creator entered. Absent when redacted. */
    value: z.string().max(4096).optional(),
    redacted: z.boolean().default(false),
    redactionReason: RedactionReason.optional(),

    /** Storage ref for a step thumbnail. UI only — never a resolution input. */
    thumb: z.string().max(256).optional(),

    /** Creator annotation added while reviewing the trace. */
    note: z.string().max(2048).optional(),
  })
  .strict();

export type TraceEvent = z.infer<typeof TraceEvent>;

/** Transcribed narration, time-aligned to events. */
export const NarrationSegment = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    text: z.string().max(4096),
  })
  .strict();

export const Trace = z
  .object({
    traceId: z.string().uuid(),
    createdBy: z.string().max(256),
    createdAt: z.string().datetime(),
    /** Recording may span several sittings. */
    sessions: z.number().int().min(1).default(1),
    durationMs: z.number().int().min(0),
    /** Every app touched — real workflows cross apps. */
    apps: z.array(z.string().max(64)).max(32),
    events: z.array(TraceEvent).max(2000),
    narration: z.array(NarrationSegment).max(1000).optional(),
    /** Pasted setup doc fused with the recording by the intent compiler. */
    sourceDoc: z.string().max(100_000).optional(),
  })
  .strict();

export type Trace = z.infer<typeof Trace>;
