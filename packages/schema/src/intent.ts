import { z } from "zod";
import { ElementDescriptor, PageContext } from "./descriptor.js";

/**
 * IntentLink — the portable artifact.
 *
 * Produced by the intent compiler from a Trace (+ narration, + pasted doc).
 * Steps carry TOOL-AGNOSTIC semantic actions; the recorded descriptors ride
 * along only as resolution hints. That split is what lets a workflow recorded
 * by clicking in one UI execute against a different UI, a different tenant, or
 * a different locale.
 */

export const ParamType = z.enum([
  "string",
  "number",
  "boolean",
  "email",
  "url",
  "date",
  "enum",
]);
export type ParamType = z.infer<typeof ParamType>;

export const Parameter = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    type: ParamType,
    required: z.boolean().default(true),
    description: z.string().max(512).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Receiver-supplied values are validated against these BEFORE any run. */
    enumValues: z.array(z.string().max(256)).max(64).optional(),
    pattern: z.string().max(512).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Recorded value this parameter was generalized from. Shown in review. */
    recordedExample: z.string().max(512).optional(),
  })
  .strict();

export type Parameter = z.infer<typeof Parameter>;

/** A literal, or a reference to a declared parameter. Nothing else. */
export const ArgValue = z.union([
  z.object({ literal: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  z.object({ param: z.string().max(64) }).strict(),
]);
export type ArgValue = z.infer<typeof ArgValue>;

/**
 * Tool-agnostic action. `verb` is the policy surface: rules match on verb and
 * object, never on a tool name or a URL.
 */
export const SemanticAction = z
  .object({
    verb: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    object: z.string().max(256).optional(),
    args: z.record(z.string().max(64), ArgValue).default({}),
  })
  .strict();

export type SemanticAction = z.infer<typeof SemanticAction>;

/** Checked before (pre) and after (post) a step. Post-assertions are how we
 *  verify by independent read-back instead of trusting a return code. */
export const Assertion = z
  .object({
    describe: z.string().max(512),
    /** Element expected to exist / hold a value once the step succeeded. */
    target: ElementDescriptor.partial().optional(),
    expect: z
      .object({
        exists: z.boolean().optional(),
        valueEquals: ArgValue.optional(),
        checked: z.union([z.boolean(), z.literal("mixed")]).optional(),
        textContains: z.string().max(512).optional(),
      })
      .strict(),
  })
  .strict();

export type Assertion = z.infer<typeof Assertion>;

export const Step = z
  .object({
    id: z.string().max(64),
    title: z.string().max(256),
    /**
     * Where this step was recorded.
     *
     * Derived from the events it cites, not from the model. The receiver has
     * to start on the page the first step happens on, and app identity alone
     * cannot say which that is: a recording that began with a Google search
     * and ended in Gmail has both pages under one app name, and starting at
     * the first of them opened a search page with no Compose button on it.
     */
    page: PageContext.optional(),
    /** Why this step exists, in human terms. Often from narration. */
    intent: z.string().max(2048).optional(),
    app: z.string().max(64),
    action: SemanticAction,

    /** Descriptors from the recording. Hints for resolution — not identity. */
    hints: z.array(ElementDescriptor).max(8).default([]),
    /** Hints contributed by receivers who corrected a resolution (self-healing). */
    learnedHints: z.array(ElementDescriptor).max(32).default([]),

    dependsOn: z.array(z.string().max(64)).max(32).default([]),
    optional: z.boolean().default(false),
    /** Natural-language condition, evaluated against observed state. */
    condition: z.string().max(512).optional(),
    /** Repeat the step over a parameter's values. */
    forEach: z.string().max(64).optional(),

    pre: z.array(Assertion).max(8).default([]),
    post: z.array(Assertion).max(8).default([]),

    /** Lets a re-run detect "already done" instead of duplicating work. */
    idempotencyKey: z.string().max(256).optional(),
    /** Best-effort undo, when one exists. */
    rollback: SemanticAction.optional(),
  })
  .strict();

export type Step = z.infer<typeof Step>;

export const IntentStatus = z.enum([
  "draft",
  "published",
  "deprecated",
  "revoked",
]);
export type IntentStatus = z.infer<typeof IntentStatus>;

export const IntentLink = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().min(1),
    title: z.string().max(256),
    goal: z.string().max(2048),
    context: z.string().max(4096).optional(),

    params: z.array(Parameter).max(32).default([]),
    steps: z.array(Step).max(200),
    /** Workflow-level outcomes, verified after all steps. */
    outcomes: z.array(Assertion).max(32).default([]),

    /** Policy that governs execution. Pinned by hash at run start. */
    policyId: z.string().uuid(),

    traceId: z.string().uuid().optional(),
    status: IntentStatus.default("draft"),
    createdBy: z.string().max(256),
    createdAt: z.string().datetime(),
    /** Lineage when forked from another IntentLink. */
    forkedFrom: z.string().uuid().optional(),
  })
  .strict();

export type IntentLink = z.infer<typeof IntentLink>;
