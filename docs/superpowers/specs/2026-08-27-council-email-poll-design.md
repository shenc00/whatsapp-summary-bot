# Council Email → WhatsApp Poll

## Purpose

The building management (`kiresidencesma@gmail.com`) emails council members, `cshen.1002@gmail.com` (the bot owner) among several recipients. Some emails are pure discussion/information; others require the council to make a decision. This feature detects the latter and turns them into a WhatsApp poll in the "The OG Ki Council" group, so the council can vote without anyone manually retyping the question.

## Architecture

- `src/gmail.js` — Gmail OAuth client (via `googleapis`) + `fetchCouncilCandidateEmails()`.
- `src/claude.js` — new `classifyCouncilEmail(subject, body)` function alongside the existing summarisation/reply functions.
- `src/council.js` — orchestration: fetch → classify → post poll → mark processed.
- `src/index.js` — wires a 60-minute `setInterval` and a manual `!councilpoll` command, both calling `council.js`'s `runCouncilCheck(client, selfChat)`.
- `src/gmail-auth.js` — one-time interactive OAuth setup script (`npm run gmail:auth`).

## Data flow

1. **Fetch**: `gmail.js` queries Gmail for `from:kiresidencesma@gmail.com to:cshen.1002@gmail.com newer_than:7d` (the `to:` filter matches even when `cshen.1002@gmail.com` is one of several recipients). Message IDs already present in `council-state.json` are skipped.
2. **Classify**: each new email's subject + plain-text body is sent to `classifyCouncilEmail()`, which returns strict JSON:
   ```json
   { "needsDecision": true, "question": "...", "options": ["...", "..."] }
   ```
   `needsDecision: false` for discussion/informational emails. `options` is omitted/empty when the email doesn't spell out explicit choices.
3. **Post poll**: for every `needsDecision: true` result, resolve the chat named "The OG Ki Council" (reuse the existing name-matching logic pattern from `resolveChatRef` in `index.js`), send a one-line context message (`📧 <subject> — from kiresidencesma@gmail.com`), then send a `Poll`:
   - options = Claude's extracted options, or `['Yes', 'No', 'Abstain']` if none were given.
   - `allowMultipleAnswers: false` (single choice).
4. **Mark processed**: the Gmail message ID is recorded in `council-state.json` regardless of `needsDecision` outcome, so no email is classified twice.

## Config additions

`.env.example` gains:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — from a Google Cloud OAuth client (Desktop app type), created by the user in Cloud Console.
- `COUNCIL_SENDER` (default `kiresidencesma@gmail.com`)
- `COUNCIL_GROUP_NAME` (default `The OG Ki Council`)

`gmail-token.json` (OAuth token cache, written by `gmail-auth.js`) is added to `.gitignore`, alongside the existing `.env`/`.wwebjs_auth` entries.

## Error handling

- Interval-run errors: `console.error` + a short warning sent to the owner's own Saved Messages chat (there's no command context to reply into from a background timer). Mirrors the existing `overloadOrGenericMessage` pattern in `index.js`.
- `!councilpoll` errors: flow through the existing per-command try/catch in `index.js`, same as every other command.
- Startup guard: if `gmail-token.json` is missing, log an error pointing at `npm run gmail:auth` and skip starting the interval (same style as the existing `ANTHROPIC_API_KEY` check), but still let the rest of the bot run.

## Setup prerequisites (one-time, user action)

1. Google Cloud Console → new/existing project → enable the **Gmail API**.
2. OAuth consent screen → External → add `cshen.1002@gmail.com` as a test user.
3. Credentials → Create Credentials → OAuth client ID → type **Desktop app** → note Client ID + Secret → put in `.env`.
4. Run `npm run gmail:auth` once → opens a consent URL, catches the redirect on a temporary local server, writes `gmail-token.json`.

## Validation before deploying automation

Before wiring the 60-minute interval into `index.js`'s startup:
1. Run the fetch + classify pipeline live against the real inbox.
2. Pick the single latest email where `needsDecision: true`.
3. Post that one as a real poll in "The OG Ki Council" now, and visually confirm it looks right (question, options, single-choice).
4. Only then add the `setInterval` wiring and the `!councilpoll` command to `index.js`.

## Testing

No existing test framework in this repo (zero test infra currently) — matching that, not introducing one. A small `test_council.js` assert-based self-check covers the pure logic only:
- options-fallback (`Yes/No/Abstain` when Claude returns no explicit options)
- dedup-by-message-ID filtering against a fake `council-state.json`
- a stubbed Claude response feeding `classifyCouncilEmail`'s JSON-parsing path

Live Gmail fetch, real OAuth, and real WhatsApp poll delivery are exercised only by the manual validation step above — they need live credentials by nature and aren't suitable for an automated self-check.

## Out of scope

- No handling of poll *results* (reading back votes) — this feature only posts the poll.
- No retry/backoff for Gmail API errors beyond what `googleapis` does by default.
- No support for multiple council WhatsApp groups — one hardcoded group name via `COUNCIL_GROUP_NAME`.
