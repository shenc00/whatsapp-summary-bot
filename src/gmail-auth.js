// One-time interactive Gmail OAuth setup. Run: npm run gmail:auth
require('dotenv').config();
const http = require('http');
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

const port = Number(new URL(REDIRECT_URI).port);
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.end('Not found.');
    return;
  }
  const code = new URL(req.url, REDIRECT_URI).searchParams.get('code');
  res.end('Authenticated — you can close this tab and return to the terminal.');
  server.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log(`✅ Saved Gmail token to ${TOKEN_PATH}`);
  } catch (err) {
    console.error('❌ Failed to exchange code for token:', err.message);
    process.exitCode = 1;
  }
});

server.listen(port, () => {
  console.log('\n📧 Open this URL in a browser and approve access with cshen.1002@gmail.com:\n');
  console.log(authUrl + '\n');
});
