import { test } from "node:test";
import assert from "node:assert/strict";
import { Trace } from "@intentlink/schema";
import { describeIssues, fitTrace } from "./fit.js";

const base = (target: Record<string, unknown>, value?: string) => ({
  traceId: "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
  createdBy: "creator",
  createdAt: "2026-10-18T05:00:00.000Z",
  sessions: 1,
  durationMs: 1000,
  apps: ["console"],
  events: [{
    seq: 0, t: 0, type: value === undefined ? "click" : "fill", redacted: false,
    page: { app: "console", origin: "https://console.cloud.google.com", path: "/iam-admin/" + "x".repeat(3000), title: "T".repeat(900) },
    target,
    ...(value === undefined ? {} : { value }),
  }],
});

test("an oversized label no longer sinks the whole recording", () => {
  const raw = base({ role: "button", name: "Grant access to ".repeat(200), nameSource: "text",
    nearby: Array.from({ length: 20 }, () => "n".repeat(400)) });
  assert.equal(Trace.safeParse(raw).success, false, "the raw recording is over the limits");
  const fitted = Trace.parse(fitTrace(raw));
  const ev = fitted.events[0]!;
  assert.equal(ev.target!.name.length, 512);
  assert.ok(ev.target!.name.startsWith("Grant access to "), "trimmed, not replaced");
  assert.equal(ev.target!.nearby!.length, 8);
  assert.equal(ev.page.path.length, 2048);
  assert.equal(ev.page.title!.length, 512);
});

test("what the person typed is never trimmed, and the refusal says where", () => {
  const raw = base({ role: "textbox", name: "Message", nameSource: "aria-label" }, "v".repeat(5000));
  const parsed = Trace.safeParse(fitTrace(raw));
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(describeIssues(parsed.error), /events\.0\.value/);
});
