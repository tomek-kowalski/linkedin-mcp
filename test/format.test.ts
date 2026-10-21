import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { escapeLittleText, formatCommentary, MAX_COMMENTARY, normalizeText, plainText, RESERVED, textLength } from "../src/format.js";
import { clearSecrets, REDACTED, redactString, registerSecret, sanitize } from "../src/sanitize.js";

beforeEach(() => clearSecrets());

test("every reserved character is backslash-escaped", () => {
  assert.equal(RESERVED.length, 15);
  assert.equal(escapeLittleText("a|b{c}d@e[f]g(h)i<j>k#l\\m*n_o~p"), "a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\#l\\\\m\\*n\\_o\\~p");
  assert.equal(escapeLittleText("Zażółć gęślą jaźń. Straße!"), "Zażółć gęślą jaźń. Straße!");
});

test("formatCommentary: #word hashtags sent plain (as in the Posts API examples), other # escaped", () => {
  assert.equal(formatCommentary("  Line 1\r\nLine 2 #WooCommerce, #Wydajność.\nC# and issue #12 x#y #3D  "),
    "Line 1\nLine 2 #WooCommerce, #Wydajność.\nC\\# and issue \\#12 x\\#y #3D");
  assert.equal(formatCommentary("#tag_with_underscore"), "\\#tag\\_with\\_underscore");
  assert.equal(formatCommentary("#a", { hashtags: false }), "\\#a");
  assert.equal(formatCommentary("Bullets:\n* one\n* two"), "Bullets:\n\\* one\n\\* two");
});

test("German and Polish text: umlauts, ß, NFD input composed, emoji counted once", () => {
  const de = "Größere Datenbanken: weniger Abfragen (–40 %) #Datenbankoptimierung #Größe";
  assert.equal(formatCommentary(de), "Größere Datenbanken: weniger Abfragen \\(–40 %\\) #Datenbankoptimierung #Größe");
  assert.equal(formatCommentary(de.normalize("NFD")), formatCommentary(de));
  assert.equal(formatCommentary("Zażółć gęślą jaźń #Wydajność"), "Zażółć gęślą jaźń #Wydajność");
  assert.equal(formatCommentary("Straße"), "Straße"); // ß is not folded to ss
  assert.equal(textLength("👍👍"), 2);
  assert.equal(normalizeText("a\r\nb\rc "), "a\nb\nc");
  // 3000 emoji are 6000 UTF-16 units but 3000 characters
  assert.doesNotThrow(() => formatCommentary("👍".repeat(MAX_COMMENTARY)));
});

test("formatCommentary: empty and too long are refused (an internal limit)", () => {
  assert.throws(() => formatCommentary("   "), RangeError);
  assert.equal(formatCommentary("x".repeat(MAX_COMMENTARY)).length, MAX_COMMENTARY);
  assert.throws(() => formatCommentary("x".repeat(MAX_COMMENTARY + 1)), /3000/);
});

test("plainText undoes the formatting and LinkedIn's returned templates (for matching a posted text)", () => {
  for (const text of ["Kod (PHP) w 3 krokach_ok? #WooCommerce\nhttps://foreachurl.app/en/news/a_b", "Größe {x} [y] <z> @me ~ * | \\ #12 #Lösung"]) {
    assert.equal(plainText(formatCommentary(text)), text);
  }
  assert.equal(plainText("Hi @[ForeachURL](urn:li:organization:123) {hashtag|＃|Tag} {hashtag|\\#|Größe}"), "Hi ForeachURL #Tag #Größe");
  assert.equal(plainText("Größe"), "Größe");
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
