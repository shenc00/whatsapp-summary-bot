// One-time interactive Gmail OAuth setup. Run: npm run gmail:auth
require('dotenv').config();
const readline = require('readline');
const fs = require('fs');
const { google } = require('googleapis');
const { REDIRECT_URI, SCOPES, TOKEN_PATH } = require('./gmail');

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error('❌ Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see .env.example).');
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n📧 Open this URL in a browser and approve access with cshen.1002@gmail.com:\n');
console.log(authUrl + '\n');
// ponytail: no local callback server — this runs on a remote VPS while the
// browser is local, so the redirect to localhost always fails there anyway.
// The code sits right in that failed URL's query string; paste it back here.
console.log('The browser will land on a "site can\'t be reached" page after approving — that\'s expected.');
console.log('Copy the "code=" value (or the whole URL) from its address bar and paste it below.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste code or redirected URL: ', async (answer) => {
  rl.close();
  const trimmed = answer.trim();
  const code = trimmed.includes('code=')
    ? new URL(trimmed, REDIRECT_URI).searchParams.get('code')
    : trimmed;
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log(`✅ Saved Gmail token to ${TOKEN_PATH}`);
  } catch (err) {
    console.error('❌ Failed to exchange code for token:', err.message);
    process.exitCode = 1;
  }
});
