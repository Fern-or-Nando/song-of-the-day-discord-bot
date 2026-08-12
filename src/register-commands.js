const { REST, Routes } = require('discord.js');
const config = require('./config');
const { buildCommands } = require('./commands');

async function main() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);
  await rest.put(route, { body: buildCommands() });
  console.log(`Registered ${config.guildId ? 'guild' : 'global'} slash commands.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
