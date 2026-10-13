/**
 * The policy service — the only authority in the system.
 *
 * Two endpoints carry the whole trust model, and they are deliberately called
 * by two different principals:
 *
 *   POST /v1/decide   called by the AGENT (server-side, from ADK's before-tool
 *                     callback). Returns a Decision, and on ALLOW a token.
 *   POST /v1/redeem   called by the EXTENSION. Spends the token. The extension
 *                     holds no secret and cannot verify a signature itself, so
 *                     it cannot act without this round trip succeeding.
 *
 * That split is the point. The agent reasons but cannot authorize; the
 * extension acts but cannot authorize; authority lives here, in a third
 * process neither of them controls.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  Policy,
  ProposedAction,
  type Decision,
} from "@intentlink/schema";
import { consentPage, publish, type PublishedLink } from "./publish.js";
import {
  entryForDecision,
  evaluate,
  evaluateForPreview,
  issueToken,
  policyHash,
  summarize,
  verifyAndSpend,
  verifyChain,
  type EvalContext,
} from "@intentlink/policy";
import { MemoryStore, createStore, type Store } from "./store.js";

/* ----------------------------- configuration ----------------------------- */

/**
 * Never a literal. The service refuses to start without a signing secret
 * rather than falling back to a default, because a predictable secret means
 * the extension could mint its own tokens and the whole model collapses.
 */
function requireSecret(): string {
  const secret = process.env.INTENTLINK_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "INTENTLINK_TOKEN_SECRET must be set to at least 32 characters (use Secret Manager in deployed environments)",
    );
  }
  return secret;
}

const MAX_BODY_BYTES = 1_000_000;

/* ------------------------------- in-memory state -------------------------- */
/* Postgres replaces these; the shapes are what the service needs, not the
 * storage. Keeping them behind these interfaces is what makes that swap dull. */

/* --------------------------------- helpers -------------------------------- */

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("payload too large");
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/* -------------------------------- handlers -------------------------------- */

export interface DecideRequest {
  policyId: string;
  action: unknown;
  receiver?: string;
  /** Values the agent is permitted to type: params + recorded literals. */
  allowedValues?: Array<string | number | boolean>;
  /** Plan preview: returns the same verdict but never issues a token. */
  preview?: boolean;
}

export async function handleDecide(
  store: Store,
  secret: string,
  body: DecideRequest,
  now: Date,
): Promise<{ status: number; payload: unknown }> {
  const policy = await store.getPolicy(body.policyId);
  if (!policy) return { status: 404, payload: { error: "unknown policy" } };

  const parsed = ProposedAction.safeParse(body.action);
  if (!parsed.success) {
    return { status: 400, payload: { error: "invalid action", detail: parsed.error.issues } };
  }
  const action = parsed.data;

  const counters = await store.getCounters(action.executionId, now.getTime());

  const ctx: EvalContext = {
    now,
    actionsUsed: counters.actionsUsed,
    actionsInLastMinute: counters.actionsInLastMinute,
    executionsUsed: 0,
  };
  if (body.receiver !== undefined) ctx.receiver = body.receiver;
  if (body.allowedValues !== undefined) ctx.allowedValues = body.allowedValues;

  const pinnedHash = await store.getPin(action.executionId);
  if (pinnedHash !== undefined) ctx.pinnedPolicyHash = pinnedHash;

  const decision: Decision = body.preview
    ? evaluateForPreview(policy, action, ctx)
    : evaluate(policy, action, ctx);

  // Every decision is logged, including blocks. A log of only successes cannot
  // answer the receiver's real question, which is "what did it try?".
  const resource = action.origin ? `${action.origin}${action.path ?? ""}` : undefined;
  await store.append(action.executionId, {
    kind:
      decision.outcome === "ALLOW"
        ? "action_proposed"
        : decision.outcome === "APPROVAL"
          ? "approval_requested"
          : "action_blocked",
    executionId: action.executionId,
    at: now.toISOString(),
    stepId: action.stepId,
    verb: action.verb,
    outcome: decision.outcome,
    detail: decision.reason,
    ...(action.object !== undefined ? { object: action.object } : {}),
    ...(resource !== undefined ? { resource } : {}),
    ...(decision.ruleId !== undefined ? { ruleId: decision.ruleId } : {}),
    ...(decision.sourceText !== undefined ? { sourceText: decision.sourceText } : {}),
  });

  if (decision.outcome !== "ALLOW" || body.preview) {
    return { status: 200, payload: decision };
  }

  const binding: Parameters<typeof issueToken>[1] = {
    executionId: action.executionId,
    stepId: action.stepId,
    verb: action.verb,
  };
  if (action.targetHash !== undefined) binding.targetHash = action.targetHash;

  const issueOpts: Parameters<typeof issueToken>[2] = {
    ttlSeconds: 30,
    now,
  };
  if (decision.ruleId !== undefined) issueOpts.ruleId = decision.ruleId;

  const { token } = issueToken(secret, binding, issueOpts);

  await store.countAction(action.executionId, now.getTime());

  return { status: 200, payload: { ...decision, token } };
}

export interface RedeemRequest {
  token: string;
  executionId: string;
  stepId: string;
  verb: string;
  targetHash?: string;
}

export async function handleRedeem(
  store: Store,
  secret: string,
  body: RedeemRequest,
  now: Date,
): Promise<{ status: number; payload: unknown }> {
  const intent: Parameters<typeof verifyAndSpend>[2] = {
    executionId: body.executionId,
    stepId: body.stepId,
    verb: body.verb,
  };
  if (body.targetHash !== undefined) intent.targetHash = body.targetHash;

  const result = await verifyAndSpend(secret, body.token, intent, store.tokens, now);

  await store.append(body.executionId, {
    kind: result.ok ? "action_executed" : "action_blocked",
    executionId: body.executionId,
    at: now.toISOString(),
    stepId: body.stepId,
    verb: body.verb,
    ...(result.ok ? {} : { detail: `token rejected: ${result.reason}` }),
  });

  if (!result.ok) {
    // 403, not 400: the request was well-formed, the authority was not valid.
    return { status: 403, payload: { ok: false, reason: result.reason } };
  }
  return { status: 200, payload: { ok: true, claims: result.claims } };
}

export { MemoryStore, createStore };
export type { Store };

/** Absolute base for links we hand out, honouring a proxy when deployed. */
function baseUrl(req: IncomingMessage): string {
  const configured = process.env.INTENTLINK_PUBLIC_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

/* --------------------------------- routing -------------------------------- */

export function createApp(store: Store, secret: string, clock: () => Date = () => new Date()) {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (req.method === "GET" && url.pathname === "/healthz") {
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && url.pathname === "/v1/publish") {
          const body = (await readJson(req)) as {
            trace?: unknown;
            boundaries?: string;
            createdBy?: string;
            title?: string;
          };
          if (!body.trace || typeof body.boundaries !== "string") {
            return json(res, 400, { error: "trace and boundaries are required" });
          }

          const link = await publish({
            trace: body.trace,
            boundaries: body.boundaries,
            ...(body.createdBy !== undefined ? { createdBy: body.createdBy } : {}),
            ...(body.title !== undefined ? { title: body.title } : {}),
          });

          // The policy is registered under the same id the agent will pin, so
          // publishing and executing cannot disagree about what was consented to.
          await store.putPolicy(link.policy);
          await store.putLink(link);

          return json(res, 200, {
            id: link.id,
            url: `${baseUrl(req)}/i/${link.id}`,
            runnable: link.runnable,
            diagnostics: link.diagnostics,
            bindings: link.bindings,
            params: link.intent.params,
            steps: link.intent.steps.length,
          });
        }

        if (req.method === "GET" && url.pathname.startsWith("/i/")) {
          const link = await store.getLink(url.pathname.slice(3));
          if (!link) return html(res, 404, "<h1>No such IntentLink</h1>");
          return html(res, 200, consentPage(link, baseUrl(req)));
        }

        if (req.method === "GET" && url.pathname.startsWith("/v1/links/")) {
          const link = await store.getLink(url.pathname.slice("/v1/links/".length));
          if (!link) return json(res, 404, { error: "no such link" });
          // The receiver's agent needs the workflow and the policy id; the
          // policy itself stays server-side, where it is evaluated.
          return json(res, 200, {
            id: link.id,
            intent: link.intent,
            policyId: link.policy.id,
            runnable: link.runnable,
            startUrl: link.startUrl,
            // Where the receiver's agent reasons. Separate from this service
            // on purpose - the agent proposes, this one decides - so the
            // extension has to be told both.
            agentUrl: process.env.INTENTLINK_AGENT_URL ?? "http://127.0.0.1:8081",
          });
        }

        if (req.method === "PUT" && url.pathname === "/v1/policies") {
          const parsed = Policy.safeParse(await readJson(req));
          if (!parsed.success) {
            return json(res, 400, { error: "invalid policy", detail: parsed.error.issues });
          }
          // The hash is computed here, never accepted from the client: it is an
          // integrity claim about what the service holds.
          const stored = Policy.parse({ ...parsed.data, hash: policyHash(parsed.data) });
          await store.putPolicy(stored);
          return json(res, 200, { id: stored.id, hash: stored.hash });
        }

        if (req.method === "POST" && url.pathname === "/v1/executions") {
          const body = (await readJson(req)) as { executionId?: string; policyId?: string };
          const policy = body.policyId ? await store.getPolicy(body.policyId) : undefined;
          if (!body.executionId || !policy) {
            return json(res, 400, { error: "executionId and a known policyId are required" });
          }
          // Pin the policy hash for the life of this execution, so an edit made
          // after the receiver consented cannot take effect mid-run.
          const pinnedHash = policy.hash ?? policyHash(policy);
          await store.pin(body.executionId, pinnedHash);
          await store.append(body.executionId, {
            kind: "execution_started",
            executionId: body.executionId,
            at: clock().toISOString(),
          });
          return json(res, 200, { executionId: body.executionId, pinnedHash });
        }

        if (req.method === "POST" && url.pathname === "/v1/decide") {
          const body = (await readJson(req)) as DecideRequest;
          const { status, payload } = await handleDecide(store, secret, body, clock());
          return json(res, status, payload);
        }

        if (req.method === "POST" && url.pathname === "/v1/redeem") {
          const body = (await readJson(req)) as RedeemRequest;
          const { status, payload } = await handleRedeem(store, secret, body, clock());
          return json(res, status, payload);
        }

        if (req.method === "GET" && url.pathname.startsWith("/v1/audit/")) {
          const executionId = decodeURIComponent(url.pathname.slice("/v1/audit/".length));
          const log = await store.getAudit(executionId);
          return json(res, 200, {
            entries: log,
            summary: summarize(log),
            chain: verifyChain(log),
          });
        }

        return json(res, 404, { error: "not found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        return json(res, 400, { error: message });
      }
    })();
  });
}

/* ---------------------------------- main ---------------------------------- */

const isEntrypoint = process.argv[1]?.endsWith("server.js");
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8080);
  // Top-level await: the store may need to construct a Firestore client.
  const store = await createStore();
  createApp(store, requireSecret()).listen(port, () => {
    console.log(
      `policy service listening on :${port} (store: ${process.env.INTENTLINK_STORE ?? "memory"})`,
    );
  });
}
