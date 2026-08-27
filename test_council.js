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
console.log('All council tests passed.');
