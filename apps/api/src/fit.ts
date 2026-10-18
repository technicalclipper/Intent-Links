/**
 * Fitting a recording to the trace schema's size limits before validating it.
 *
 * A real recording failed to publish - instantly, every time - and the cause
 * was a single oversized label. Cloud consoles and chat apps give whole cards
 * and messages an accessible name, so one control's "name" can run to
 * thousands of characters, and the schema caps it at 512. The whole recording
 * was refused over metadata nobody types.
 *
 * Descriptive fields are therefore trimmed to their limits: they identify a
 * control, and the first few hundred characters identify it as well as all of
 * them. What the person TYPED is never trimmed - silently shortening an email
 * body would publish a workflow that sends something else - so an oversized
 * value still fails, with a message that says which one.
 */

import type { ZodError } from "zod";

const LIMITS = {
  role: 64,
  name: 512,
  section: 512,
  landmark: 64,
  nearbyItem: 256,
  nearbyCount: 8,
  pathSegment: 64,
  pathCount: 12,
  pageTitle: 512,
  pagePath: 2048,
  routeTemplate: 2048,
  app: 64,
  note: 2048,
} as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (v: unknown, max: number) => (typeof v === "string" && v.length > max ? v.slice(0, max) : v);

function fitDescriptor(d: unknown): unknown {
  if (!isObj(d)) return d;
  const out: Json = { ...d };
  out["role"] = cut(out["role"], LIMITS.role);
  out["name"] = cut(out["name"], LIMITS.name);
  if ("section" in out) out["section"] = cut(out["section"], LIMITS.section);
  if ("landmark" in out) out["landmark"] = cut(out["landmark"], LIMITS.landmark);
  if (Array.isArray(out["nearby"])) {
    out["nearby"] = out["nearby"].slice(0, LIMITS.nearbyCount).map((n) => cut(n, LIMITS.nearbyItem));
  }
  if (Array.isArray(out["path"])) {
    out["path"] = out["path"].slice(-LIMITS.pathCount).map((p) => cut(p, LIMITS.pathSegment));
  }
  return out;
}

function fitPage(p: unknown): unknown {
  if (!isObj(p)) return p;
  const out: Json = { ...p };
  out["app"] = cut(out["app"], LIMITS.app);
  out["path"] = cut(out["path"], LIMITS.pagePath);
  if ("title" in out) out["title"] = cut(out["title"], LIMITS.pageTitle);
  if ("routeTemplate" in out) out["routeTemplate"] = cut(out["routeTemplate"], LIMITS.routeTemplate);
  return out;
}

/** A copy of `raw` with every descriptive field within its limit. */
export function fitTrace(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const out: Json = { ...raw };
  if (Array.isArray(out["apps"])) out["apps"] = out["apps"].map((a) => cut(a, LIMITS.app));
  if (Array.isArray(out["events"])) {
    out["events"] = out["events"].map((e) => {
      if (!isObj(e)) return e;
      const ev: Json = { ...e, page: fitPage(e["page"]) };
      if ("target" in ev) ev["target"] = fitDescriptor(ev["target"]);
      if ("note" in ev) ev["note"] = cut(ev["note"], LIMITS.note);
      return ev;
    });
  }
  return out;
}

/** "events.12.value: String must contain at most 4096 character(s)", not a JSON dump. */
export function describeIssues(err: ZodError, max = 3): string {
  const shown = err.issues.slice(0, max).map((i) => `${i.path.join(".") || "recording"}: ${i.message}`);
  const more = err.issues.length > max ? ` (and ${err.issues.length - max} more)` : "";
  return `the recording could not be read - ${shown.join("; ")}${more}`;
}
