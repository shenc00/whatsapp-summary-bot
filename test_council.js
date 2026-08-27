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

  const htmlWithStylePayload = {
    mimeType: 'multipart/alternative',
    parts: [
      {
        mimeType: 'text/html',
        body: {
          data: Buffer.from('<style>body{color:red}</style><p>Real content</p>').toString('base64url'),
        },
      },
    ],
  };
  assert.strictEqual(extractBody(htmlWithStylePayload), 'Real content');

  console.log('gmail.js: PASS');
}

testGmailHelpers();

function testClaudeHelpers() {
  const { parseClassification } = require('./src/claude');

  const clean = parseClassification('{"needsDecision": true, "question": "Approve the new gate vendor?", "options": ["Vendor A", "Vendor B"]}');
  assert.deepStrictEqual(clean, { needsDecision: true, background: '', question: 'Approve the new gate vendor?', options: ['Vendor A', 'Vendor B'] });

  // A response carrying the background sentence keeps it.
  const withBackground = parseClassification('{"needsDecision": true, "background": "Office picked two vendors.", "question": "Approve?", "options": ["Yes", "No"]}');
  assert.deepStrictEqual(withBackground, { needsDecision: true, background: 'Office picked two vendors.', question: 'Approve?', options: ['Yes', 'No'] });

  const fenced = parseClassification('```json\n{"needsDecision": false, "question": "", "options": []}\n```');
  assert.deepStrictEqual(fenced, { needsDecision: false, background: '', question: '', options: [] });

  const garbage = parseClassification('not json at all');
  assert.deepStrictEqual(garbage, { needsDecision: false, background: '', question: '', options: [] });

  console.log('claude.js: PASS');
}

testClaudeHelpers();

function testCouncilHelpers() {
  const { optionsWithFallback, capQuestion, pollQuestion, normalizeSubject, FALLBACK_OPTIONS } = require('./src/council');

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

  // A yes/no vote needs no opt-out — "Abstain" is dropped, not offered.
  assert.deepStrictEqual(optionsWithFallback(['Yes', 'No', 'Abstain']), ['Yes', 'No']);
  assert.deepStrictEqual(optionsWithFallback(['Approve', 'Reject', 'No opinion']), ['Approve', 'Reject']);
  // Dropping the opt-out must not push a real 2-option vote below the minimum.
  assert.deepStrictEqual(optionsWithFallback(['Approve', 'Abstain']), FALLBACK_OPTIONS);
  assert.deepStrictEqual(FALLBACK_OPTIONS, ['Yes', 'No']);

  // Every reply in a thread collapses to one key, so one subject = one poll.
  assert.strictEqual(normalizeSubject('RE: Shuttle Bus Arrangement'), 'shuttle bus arrangement');
  assert.strictEqual(normalizeSubject('Fwd: RE:  Shuttle   Bus Arrangement '), 'shuttle bus arrangement');
  assert.strictEqual(normalizeSubject('Shuttle Bus Arrangement'), 'shuttle bus arrangement');
  assert.notStrictEqual(normalizeSubject('Reduce parking fees'), normalizeSubject('Raise parking fees'));

  // Background sentence leads the poll question so a member voting from the
  // notification knows the context without opening the email thread.
  assert.strictEqual(
    pollQuestion('Office proposes card payment for facility bookings.', 'Approve it?'),
    'Office proposes card payment for facility bookings. Approve it?'
  );
  // No background from the classifier leaves the question intact.
  assert.strictEqual(pollQuestion('', 'Approve it?'), 'Approve it?');
  assert.strictEqual(pollQuestion(undefined, 'Approve it?'), 'Approve it?');
  // Background plus question must still respect the 255-char poll cap.
  assert.strictEqual(pollQuestion('x'.repeat(200), 'y'.repeat(200)).length, 255);

  assert.strictEqual(capQuestion('Short question?'), 'Short question?');
  const longQuestion = 'x'.repeat(300);
  const capped = capQuestion(longQuestion);
  assert.strictEqual(capped.length, 255);
  assert.ok(capped.endsWith('…'));

  console.log('council.js: PASS');
}

testCouncilHelpers();
console.log('All council tests passed.');
