/**
 * Re-authenticate Gmail OAuth credentials.
 * Opens a browser URL — paste the auth code back to get new tokens.
 *
 * Usage: npx tsx scripts/gmail-reauth.ts
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { google } from 'googleapis';

const credDir = path.join(os.homedir(), '.gmail-mcp');
const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
const tokensPath = path.join(credDir, 'credentials.json');

const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
const { client_id, client_secret, redirect_uris } = keys.installed || keys.web || keys;

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || 'http://localhost');

// Read existing scopes or use defaults
let scopes = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.settings.basic'];
if (fs.existsSync(tokensPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    if (existing.scope) scopes = existing.scope.split(' ');
  } catch {}
}

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // Force new refresh token
  scope: scopes,
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nAfter authorizing, you\'ll be redirected to localhost with a ?code= parameter.');
console.log('Copy the code from the URL and paste it here.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Auth code: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    console.log('\nTokens saved to', tokensPath);
    console.log('Scopes:', tokens.scope);
    console.log('\nRestart nanoclaw: systemctl --user restart nanoclaw');
  } catch (err: any) {
    console.error('Failed to exchange code:', err.message);
    process.exit(1);
  }
});
