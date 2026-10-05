import { z } from "zod";

/**
 * Policy — the authority object.
 *
 * Authored in natural language by the creator, compiled by Gemini, then
 * VALIDATED AND ENFORCED DETERMINISTICALLY. The model proposes; this object
 * decides. It is evaluated server-side only, against a hash pinned at the start
 * of an execution, so nothing observed at runtime — a page's text, a tool
 * result, a resource name — can widen it.
 *
 * Rules match on SEMANTIC verbs and objects, never on tool names or URLs, so
 * one policy governs an action identically whether it executes through an API
 * or by clicking in a browser.
 */

/** Glob over semantic verbs/objects: "grant_role", "*.admin", "delete_*". */
export const Pattern = z.string().min(1).max(256);

export const ArgConstraint = z
  .object({
    arg: z.string().max(64),
    op: z.enum([
      "eq", "ne", "in", "not_in", "lt", "lte", "gt", "gte", "matches", "not_matches",
    ]),
    value: z.union([
      z.string().max(512),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string().max(512), z.number()])).max(128),
    ]),
  })
  .strict();

export type ArgConstraint = z.infer<typeof ArgConstraint>;

export const ActionRule = z
  .object({
    id: z.string().max(64),
    verb: Pattern,
    object: Pattern.optional(),
    /** All constraints must hold for the rule to match. */
    args: z.array(ArgConstraint).max(16).default([]),
    /** Verbatim creator sentence this rule compiled from. Shown on block. */
    sourceText: z.string().max(1024).optional(),
    /** Step ids this rule was grounded against at compile time. */
    boundSteps: z.array(z.string().max(64)).max(200).default([]),
  })
  .strict();

export type ActionRule = z.infer<typeof ActionRule>;

export const ApprovalRule = ActionRule.extend({
  /** Who clears it. `creator` and `two_party` prevent self-approval. */
  route: z.enum(["receiver", "creator", "two_party"]).default("receiver"),
  requireJustification: z.boolean().default(false),
  /** Seconds the resulting single-use grant stays spendable. */
  grantTtlSeconds: z.number().int().min(5).max(900).default(120),
}).strict();

export type ApprovalRule = z.infer<typeof ApprovalRule>;

export const Scope = z
  .object({
    /** Origins the agent may reach at all. Navigation is itself gated. */
    origins: z.array(Pattern).max(64).default([]),
    /** Path globs within those origins. Empty = all paths on allowed origins. */
    paths: z.array(Pattern).max(128).default([]),
    /** Named resources: project ids, channel names, board keys. */
    resources: z.array(Pattern).max(128).default([]),
    /** Data the agent must not read, even where it has access. */
    dataExclusions: z.array(Pattern).max(64).default([]),
  })
  .strict();

export const Limits = z
  .object({
    /** Numeric ceilings on action args, e.g. budget_amount <= 5000. */
    numeric: z.array(ArgConstraint).max(32).default([]),
    maxActions: z.number().int().min(1).max(10_000).default(200),
    maxExecutions: z.number().int().min(1).max(10_000).default(1),
    /** Actions per minute. */
    rateLimit: z.number().int().min(1).max(600).default(60),
    /** Bounded exploration when a target isn't on the current page. */
    maxNavigationHops: z.number().int().min(0).max(20).default(5),
  })
  .strict();

export type Scope = z.infer<typeof Scope>;
export type Limits = z.infer<typeof Limits>;

export const TimeWindow = z
  .object({
    /** IANA zone, e.g. "Asia/Kolkata". */
    tz: z.string().max(64),
    days: z.array(z.number().int().min(0).max(6)).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439),
  })
  .strict();

export type TimeWindow = z.infer<typeof TimeWindow>;

/**
 * Destructive verbs are denied unless EXPLICITLY allowed, even when the policy
 * author never anticipated the wording. A safety net under every policy —
 * see policy engine `evaluate()`.
 */
export const DEFAULT_DESTRUCTIVE_VERBS = [
  "delete", "remove", "destroy", "purge", "wipe", "revoke", "deactivate",
  "disable_account", "transfer", "pay", "send", "publish", "share_externally",
  "grant_role", "change_password", "rotate_key", "terminate", "cancel",
] as const;

export const PolicyMode = z.enum(["dry_run", "live"]);

export const Policy = z
  .object({
    id: z.string().uuid(),
    intentId: z.string().uuid(),
    version: z.number().int().min(1),

    /** sha256 over the canonicalized policy. Pinned at execution start. */
    hash: z.string().length(64).optional(),

    scope: Scope.default({}),
    allowed: z.array(ActionRule).max(256).default([]),
    denied: z.array(ActionRule).max(256).default([]),
    approvalRequired: z.array(ApprovalRule).max(128).default([]),

    limits: Limits.default({}),
    timeWindows: z.array(TimeWindow).max(8).default([]),

    /** Absolute expiry. Nothing runs after it, mid-execution included. */
    expiresAt: z.string().datetime(),

    /** Receiver allowlist: emails or @domain. Empty = anyone with the link. */
    receivers: z.array(z.string().max(256)).max(128).default([]),

    /** Extra verbs treated as destructive for this policy. */
    destructiveVerbs: z.array(z.string().max(64)).max(64).default([]),

    /** Values the agent may type. Literals come from the compiled steps;
     *  everything else must resolve from a declared parameter. */
    allowTypedLiterals: z.boolean().default(true),

    mode: PolicyMode.default("live"),
    revokedAt: z.string().datetime().optional(),

    /** Org baseline this policy inherits from and may never exceed. */
    baselineId: z.string().uuid().optional(),
  })
  .strict();

export type Policy = z.infer<typeof Policy>;

/* ------------------------------------------------------------------ *
 * Evaluation types — the contract every other track integrates against
 * ------------------------------------------------------------------ */

export const Outcome = z.enum(["ALLOW", "APPROVAL", "DENY"]);
export type Outcome = z.infer<typeof Outcome>;

/** What the agent wants to do, before it is permitted to do anything. */
export const ProposedAction = z
  .object({
    executionId: z.string().uuid(),
    stepId: z.string().max(64),
    verb: z.string().max(64),
    object: z.string().max(256).optional(),
    args: z.record(z.string().max(64), z.union([z.string(), z.number(), z.boolean()])).default({}),
    /** Where it would happen. Checked against scope.origins / scope.paths. */
    origin: z.string().max(512).optional(),
    path: z.string().max(2048).optional(),
    /** sha256 of the resolved target descriptor. The issued token is bound to
     *  this, so a token for "Save" can never be spent on "Delete". */
    targetHash: z.string().length(64).optional(),
    /** Accessible name of the resolved element — destructive-verb matching. */
    targetName: z.string().max(512).optional(),
  })
  .strict();

export type ProposedAction = z.infer<typeof ProposedAction>;

export const Decision = z
  .object({
    outcome: Outcome,
    /** Rule that determined the outcome. Absent for default-allow. */
    ruleId: z.string().max(64).optional(),
    /** The creator's own sentence, shown verbatim on the block screen. */
    sourceText: z.string().max(1024).optional(),
    reason: z.string().max(1024),
    /** A compliant action that would satisfy the step, when one exists. */
    suggestion: z.string().max(512).optional(),
    approvalRoute: z.enum(["receiver", "creator", "two_party"]).optional(),
    /** Set only on ALLOW: signed, single-use, target-bound, short-lived. */
    token: z.string().max(4096).optional(),
  })
  .strict();

export type Decision = z.infer<typeof Decision>;
