import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { classify, fieldIsSensitive, redactValue } from "./redact.js";

const pick = (html: string, sel: string): Element => {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const el = document.querySelector(sel);
  assert.ok(el, `selector ${sel} matched nothing`);
  return el as unknown as Element;
};

/* --------------------------- value-shaped secrets ------------------------- */

test("catches vendor-prefixed credentials", () => {
  for (const value of [
    "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
    "sk_test_4eC39HqLyjWDarjtT1zdp7dc",
    "AIzaSyD-ExampleKeyMaterialHere12345",
    "ghp_16CharactersAndThenSomeMore123",
  ]) {
    assert.equal(classify(value).redacted, true, `should redact ${value.slice(0, 12)}…`);
  }
});

test("catches JWTs and private keys", () => {
  assert.equal(
    classify("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p").redacted,
    true,
  );
  assert.equal(classify("-----BEGIN RSA PRIVATE KEY-----\nMIIE...").redacted, true);
});

test("catches personal data", () => {
  assert.equal(classify("sre-oncall@acme.com").reason, "email");
  assert.equal(classify("4111 1111 1111 1111").reason, "card");
  assert.equal(classify("123-45-6789").reason, "government_id");
});

test("catches in-house token formats by entropy alone", () => {
  // No recognisable vendor prefix — the kind of thing every company invents.
  assert.equal(classify("Xk7Qp2Lm9Rt4Vb8Nz3Ws6Yc1Hd5Jf0Gq").redacted, true);
});

test("leaves ordinary workflow values alone", () => {
  for (const value of [
    "inc-2026-10-05-payments",
    "Payments degraded — sev2 bridge",
    "Highest",
    "INC",
    "private",
    "5000",
  ]) {
    assert.equal(classify(value).redacted, false, `should NOT redact ${JSON.stringify(value)}`);
  }
});

/* --------------------------- field-shaped secrets ------------------------- */

test("a password field is sensitive whatever it contains", () => {
  assert.equal(fieldIsSensitive(pick(`<input type="password">`, "input")), true);
});

test("autocomplete and naming hints mark a field sensitive", () => {
  assert.equal(fieldIsSensitive(pick(`<input autocomplete="cc-number">`, "input")), true);
  assert.equal(fieldIsSensitive(pick(`<input autocomplete="one-time-code">`, "input")), true);
  assert.equal(fieldIsSensitive(pick(`<input name="api_key">`, "input")), true);
  assert.equal(fieldIsSensitive(pick(`<input aria-label="Client secret">`, "input")), true);
  assert.equal(fieldIsSensitive(pick(`<input placeholder="Card CVV">`, "input")), true);
});

test("an ordinary field is not sensitive", () => {
  assert.equal(fieldIsSensitive(pick(`<input aria-label="Channel name">`, "input")), false);
});

/* ------------------------------- the contract ----------------------------- */

test("a redacted value is DROPPED, not masked", () => {
  const out = redactValue("sk_live_4eC39HqLyjWDarjtT1zdp7dc");
  assert.equal(out.redacted, true);
  // A mask still leaks length and shape, and nothing downstream needs either.
  assert.equal(out.value, undefined);
  assert.equal(out.redactionReason, "credential");
});

test("a safe value survives intact", () => {
  const out = redactValue("inc-2026-10-05-payments");
  assert.equal(out.redacted, false);
  assert.equal(out.value, "inc-2026-10-05-payments");
});

test("field sensitivity overrides innocuous content", () => {
  // "hunter2" is not secret-shaped; the field it sits in is.
  const out = redactValue("hunter2", pick(`<input type="password">`, "input"));
  assert.equal(out.redacted, true);
  assert.equal(out.value, undefined);
});

test("an absent value stays absent without being called redacted", () => {
  const out = redactValue(undefined);
  assert.equal(out.redacted, false);
  assert.equal(out.value, undefined);
});
