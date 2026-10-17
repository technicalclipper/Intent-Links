import { test } from "node:test";
import assert from "node:assert/strict";
import { Trace, type TraceEvent } from "@intentlink/schema";
import { normalizeTrace, trimGluedName } from "./normalize.js";

const page = { app: "gmail", origin: "https://mail.google.com", path: "/mail/u/0/", title: "Inbox" };

let seq = 0;
const ev = (type: TraceEvent["type"], role: string, name: string, value?: string): TraceEvent => {
  const e: TraceEvent = { seq: seq++, t: seq * 500, type, redacted: false, page, target: { role, name, nameSource: "aria-label" } } as TraceEvent;
  if (value !== undefined) e.value = value;
  return e;
};

function trace(events: TraceEvent[]): Trace {
  return Trace.parse({
    traceId: "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
    createdBy: "creator@example.com",
    createdAt: "2026-10-17T09:00:00.000Z",
    sessions: 1,
    durationMs: 20000,
    apps: ["gmail"],
    events,
  });
}

const summary = (t: Trace) =>
  t.events.map((e) => `${e.type} ${e.target?.name ?? ""}${e.value !== undefined ? ` = ${e.value}` : ""}`);

test("an address picked from suggestions becomes a fill of that address", () => {
  seq = 0;
  const out = normalizeTrace(trace([
    ev("click", "button", "Compose"),
    ev("fill", "combobox", "To recipients", "ada"),
    ev("click", "option", "Beschi JIadaibes234@gmail.com"),
    ev("fill", "textbox", "Subject", "hello"),
  ]));
  assert.deepEqual(summary(out), [
    "click Compose",
    "fill To recipients = adaibes234@gmail.com",
    "fill Subject = hello",
  ]);
});

test("the pick recorded BEFORE the typing (older recorder order) collapses the same way", () => {
  seq = 0;
  const out = normalizeTrace(trace([
    ev("click", "button", "Compose"),
    ev("click", "option", "Beschi JIadaibes234@gmail.com"),
    ev("fill", "combobox", "To recipients", "ada"),
    ev("click", "textbox", "Subject"),
  ]));
  assert.deepEqual(summary(out), [
    "click Compose",
    "fill To recipients = adaibes234@gmail.com",
    "click Subject",
  ]);
});

test("a pick offered on focus, with nothing typed, turns the click into the field into a fill", () => {
  seq = 0;
  const out = normalizeTrace(trace([
    ev("click", "combobox", "To recipients"),
    ev("click", "option", "Sam Lee <sam@example.org>"),
  ]));
  assert.deepEqual(summary(out), ["fill To recipients = sam@example.org"]);
});

test("a suggestion with no address stays type-then-pick", () => {
  seq = 0;
  const events = [
    ev("fill", "combobox", "Assignee", "jan"),
    ev("click", "option", "Jane Doe"),
  ];
  assert.deepEqual(summary(normalizeTrace(trace(events))), ["fill Assignee = jan", "click Jane Doe"]);
});

test("typing unrelated to the suggestion is not rewritten", () => {
  seq = 0;
  const events = [
    ev("fill", "textbox", "Subject", "quarterly report"),
    ev("click", "option", "ops@example.com"),
  ];
  assert.deepEqual(summary(normalizeTrace(trace(events))), [
    "fill Subject = quarterly report",
    "click ops@example.com",
  ]);
});

test("seq numbers survive, so the model can still cite events by the numbers it was shown", () => {
  seq = 0;
  const out = normalizeTrace(trace([
    ev("fill", "combobox", "To recipients", "ada"),
    ev("click", "option", "adaibes234@gmail.com"),
    ev("click", "button", "Send"),
  ]));
  assert.deepEqual(out.events.map((e) => e.seq), [0, 2]);
});

test("a contact name glued onto the address is trimmed off", () => {
  // Gmail's label for "Beschi J I" + "adaibes234@gmail.com", no separator.
  assert.equal(trimGluedName("JIadaibes234@gmail.com", "ada"), "adaibes234@gmail.com");
  assert.equal(trimGluedName("JIadaibes234@gmail.com", ""), "adaibes234@gmail.com");
  // Typing the name rather than the address is no evidence about the address.
  assert.equal(trimGluedName("JIadaibes234@gmail.com", "bes"), "adaibes234@gmail.com");
  // Ordinary addresses are left alone.
  assert.equal(trimGluedName("sam.lee@example.org", "sam"), "sam.lee@example.org");
  assert.equal(trimGluedName("OPS@example.org", ""), "OPS@example.org");
});
