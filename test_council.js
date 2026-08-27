// test_council.js — assert-based self-check for the council-email-poll
// feature's pure logic. No framework, no network calls.
// Requires a real .env (for ANTHROPIC_API_KEY, since requiring src/claude.js
// constructs the Anthropic client). Run: node test_council.js
require('dotenv').config();
const assert = require('assert');

function testGmailHelpers() {
  const { filterUnprocessed, extractBody } = require('./src/gmail');

  const unprocessed = filterUnprocessed(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    ['a', 'c']
  );
  assert.deepStrictEqual(unprocessed.map((e) => e.id), ['b']);

  const plainTextPayload = {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hello council').toString('base64url') } }],
  };
  assert.strictEqual(extractBody(plainTextPayload), 'Hello council');

  const htmlOnlyPayload = {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>Hi <b>team</b></p>').toString('base64url') } }],
  };
  assert.strictEqual(extractBody(htmlOnlyPayload), 'Hi team');

  const nestedPayload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('Nested plain body').toString('base64url') } },
          { mimeType: 'text/html', body: { data: Buffer.from('<p>Nested html</p>').toString('base64url') } },
        ],
      },
    ],
  };
  assert.strictEqual(extractBody(nestedPayload), 'Nested plain body');

  console.log('gmail.js: PASS');
}

testGmailHelpers();

function testClaudeHelpers() {
  const { parseClassification } = require('./src/claude');

  const clean = parseClassification('{"needsDecision": true, "question": "Approve the new gate vendor?", "options": ["Vendor A", "Vendor B"]}');
  assert.deepStrictEqual(clean, { needsDecision: true, question: 'Approve the new gate vendor?', options: ['Vendor A', 'Vendor B'] });

  const fenced = parseClassification('```json\n{"needsDecision": false, "question": "", "options": []}\n```');
  assert.deepStrictEqual(fenced, { needsDecision: false, question: '', options: [] });

  const garbage = parseClassification('not json at all');
  assert.deepStrictEqual(garbage, { needsDecision: false, question: '', options: [] });

  console.log('claude.js: PASS');
}

testClaudeHelpers();

function testCouncilHelpers() {
  const { optionsWithFallback, capQuestion, FALLBACK_OPTIONS } = require('./src/council');

  assert.deepStrictEqual(optionsWithFallback(['Vendor A', 'Vendor B']), ['Vendor A', 'Vendor B']);
  assert.deepStrictEqual(optionsWithFallback([]), FALLBACK_OPTIONS);
  assert.deepStrictEqual(optionsWithFallback(undefined), FALLBACK_OPTIONS);
  // A single option is below WhatsApp's 2-option minimum — falls back.
  assert.deepStrictEqual(optionsWithFallback(['Approve']), FALLBACK_OPTIONS);
  // An over-length option would be rejected by WhatsApp — falls back rather
  // than truncating (truncating an option reads as broken).
  assert.deepStrictEqual(optionsWithFallback(['Approve', 'x'.repeat(101)]), FALLBACK_OPTIONS);
  // Exactly at the length cap is still fine.
  assert.deepStrictEqual(optionsWithFallback(['Approve', 'x'.repeat(100)]), ['Approve', 'x'.repeat(100)]);

  assert.strictEqual(capQuestion('Short question?'), 'Short question?');
  const longQuestion = 'x'.repeat(300);
  const capped = capQuestion(longQuestion);
  assert.strictEqual(capped.length, 255);
  assert.ok(capped.endsWith('…'));

  console.log('council.js: PASS');
}

testCouncilHelpers();
console.log('All council tests passed.');
