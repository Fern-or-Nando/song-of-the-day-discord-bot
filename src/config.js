const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function required(name) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  return process.env[name];
}

module.exports = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: process.env.DISCORD_GUILD_ID || null,
  timezone: process.env.SOTD_TIMEZONE || require('./schedule').DEFAULT_TIMEZONE
};
