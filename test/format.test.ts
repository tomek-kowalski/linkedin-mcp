import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { escapeLittleText, formatCommentary, MAX_COMMENTARY, plainText, RESERVED } from "../src/format.js";
import { clearSecrets, REDACTED, redactString, registerSecret, sanitize } from "../src/sanitize.js";

beforeEach(() => clearSecrets());

test("every reserved character is backslash-escaped", () => {
  assert.equal(RESERVED.length, 15);
  assert.equal(escapeLittleText("a|b{c}d@e[f]g(h)i<j>k#l\\m*n_o~p"), "a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\#l\\\\m\\*n\\_o\\~p");
  assert.equal(escapeLittleText("Zażółć gęślą jaźń. Straße!"), "Zażółć gęślą jaźń. Straße!");
});

test("formatCommentary: hashtags kept, other # escaped, newlines kept, trimmed", () => {
  assert.equal(formatCommentary("  Line 1\r\nLine 2 #WooCommerce, #Wydajność.\nC# and issue #12 x#y  "),
    "Line 1\nLine 2 {hashtag|\\#|WooCommerce}, {hashtag|\\#|Wydajność}.\nC\\# and issue {hashtag|\\#|12} x\\#y");
  assert.equal(formatCommentary("#tag_with_underscore"), "\\#tag\\_with\\_underscore");
  assert.equal(formatCommentary("#a", { hashtags: false }), "\\#a");
  assert.equal(formatCommentary("Bullets:\n* one\n* two"), "Bullets:\n\\* one\n\\* two");
});

test("formatCommentary: empty and too long are refused", () => {
  assert.throws(() => formatCommentary("   "), RangeError);
  assert.equal(formatCommentary("x".repeat(MAX_COMMENTARY)).length, MAX_COMMENTARY);
  assert.throws(() => formatCommentary("x".repeat(MAX_COMMENTARY + 1)), /3000/);
});

test("plainText undoes the formatting (for matching a posted text)", () => {
  const text = "Kod (PHP) w 3 krokach_ok? #WooCommerce\nhttps://foreachurl.app/en/news/a_b";
  assert.equal(plainText(formatCommentary(text)), text);
  assert.equal(plainText("Hi @[ForeachURL](urn:li:organization:123) {hashtag|＃|Tag}"), "Hi ForeachURL #Tag");
});

test("redaction: registered secrets, query and form parameters, JSON fields, bearer headers, secret keys", () => {
  registerSecret("supersecretvalue123");
  registerSecret("short");
  assert.equal(redactString("x supersecretvalue123 y short"), `x ${REDACTED} y short`);
  assert.equal(redactString("a?code=abc&state=xyz&access_token=t1&client_secret=s2"), `a?code=${REDACTED}&state=${REDACTED}&access_token=${REDACTED}&client_secret=${REDACTED}`);
  assert.equal(redactString("refresh_token%3Dabc"), `refresh_token%3D${REDACTED}`);
  assert.equal(redactString('{"access_token":"abc","expires_in":5}'), `{"access_token":"${REDACTED}","expires_in":5}`);
  assert.equal(redactString("Authorization: Bearer AQV.x-y_z"), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactString("serviceErrorCode=65601"), "serviceErrorCode=65601");
  assert.deepEqual(sanitize({ access_token: "a", nested: [{ refresh_token: "b", Authorization: "c", id: 1 }], lifecycleState: "PUBLISHED" }), {
    access_token: REDACTED,
    nested: [{ refresh_token: REDACTED, Authorization: REDACTED, id: 1 }],
    lifecycleState: "PUBLISHED",
  });
});
