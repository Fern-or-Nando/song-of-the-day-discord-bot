const {
  Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits
} = require('discord.js');
const config = require('./config');
const { createRunSetup } = require('./run-setup');
const { getGuild, updateGuild } = require('./storage');
const { finishCollection, handleDm, postCurrent, schedulerTick } = require('./sotd-service');
const { SONG_SELECTION_PROMPT, RUN_ENDED, selectionStarted } = require('./messages');
const runSetup = createRunSetup();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { await schedulerTick(client); } catch (error) { console.error(error); }
  finally { ticking = false; }
}
client.once(Events.ClientReady, (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
  tick();
  setInterval(tick, 30_000);
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.author.bot && !message.guild) await handleDm(message, client).catch(console.error);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild()) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Manage Server permission is required.', ephemeral: true });
      return;
    }
    if (interaction.isModalSubmit() && ['sotd-duration', 'sotd-schedule'].includes(interaction.customId)) {
      await interaction.reply({ content: 'Please reopen /start-sotd-run to use the new scheduling form.', ephemeral: true });
      return;
    }
    const isSetup = runSetup.matches(interaction);
    const setup = isSetup ? await runSetup.handle(interaction, config.timezone) : null;
    if (isSetup && !setup) return;
    if (setup) {
      const { deadline, dailyTime, timezone } = setup;
      const data = getGuild(interaction.guildId);
      if (!data.roleId) {
        await interaction.reply({ content: 'First choose a role with `/assign-sotd-role`.', ephemeral: true });
        return;
      }
      if (!data.channelId) {
        await interaction.reply({ content: 'First choose a posting destination with `/assign-sotd-channel`.', ephemeral: true });
        return;
      }
      if (data.run && data.run.status !== 'ended') {
        await interaction.reply({ content: 'A run is already active. End it before starting another.', ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const role = await interaction.guild.roles.fetch(data.roleId);
      if (!role) {
        await interaction.editReply('The configured role no longer exists. Choose another with `/assign-sotd-role`.');
        return;
      }
      const postingChannel = await interaction.guild.channels.fetch(data.channelId).catch(() => null);
      if (!postingChannel?.isTextBased() || postingChannel.isDMBased()) {
        await interaction.editReply('The configured posting channel no longer exists. Choose another with `/assign-sotd-channel`.');
        return;
      }
      if (postingChannel.isThread() && (postingChannel.archived || postingChannel.locked)) {
        await interaction.editReply('The configured thread is archived or locked. Choose an active destination with `/assign-sotd-channel`.');
        return;
      }
      const permissions = postingChannel.permissionsFor(interaction.guild.members.me);
      const sendPermission = postingChannel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.SendPolls])) {
        await interaction.editReply('I cannot view or send messages in the configured destination. Update my channel permissions or choose another channel.');
        return;
      }
      await interaction.guild.members.fetch();
      const members = role.members.filter((member) => !member.user.bot);
      if (!members.size) {
        await interaction.editReply('That role has no non-bot members.');
        return;
      }
      if (deadline.getTime() <= Date.now()) {
        await interaction.editReply('The selected end time has passed. Reopen /start-sotd-run to choose another date/time.');
        return;
      }
      // Persist the roster before any DM can be answered.
      if (getGuild(interaction.guildId).run && getGuild(interaction.guildId).run.status !== 'ended') {
        await interaction.editReply('Another run was started while this form was open.');
        return;
      }
      updateGuild(interaction.guildId, (guild) => {
        guild.run = {
          id: require('crypto').randomUUID(), roleId: data.roleId,
          status: 'collecting', channelId: data.channelId, startedAt: new Date().toISOString(),
          collectionEndsAt: deadline.toISOString(), participantIds: [...members.keys()], submissions: {},
          reminderSent: deadline.getTime() - Date.now() < 86400000,
          dailyTime, timezone, schedule: [], currentIndex: 0, nextPostAt: null
        };
        return guild;
      });
      const runId = getGuild(interaction.guildId).run.id;
      await interaction.editReply(selectionStarted(deadline));
      const failed = [];
      for (const member of members.values()) {
        if (getGuild(interaction.guildId).run?.id !== runId || getGuild(interaction.guildId).run.status !== 'collecting') break;
        const sent = await member.send(SONG_SELECTION_PROMPT).then(() => true).catch(() => false);
        if (!sent) failed.push(member.id);
      }
      updateGuild(interaction.guildId, (guild) => {
        if (guild.run?.id === runId) guild.run.failedDmIds = failed;
        return guild;
      });
      if (failed.length) {
        await interaction.followUp({ content: `${failed.length} member(s) could not be DMed. They can still submit by opening a DM with the bot.`, ephemeral: true });
      }
      return;
    }

    if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
    if (interaction.commandName === 'assign-sotd-role') {
      const role = interaction.options.getRole('role', true);
      if (role.id === interaction.guild.id) {
        await interaction.reply({ content: 'Please choose a role other than @everyone.', ephemeral: true });
        return;
      }
      updateGuild(interaction.guildId, (guild) => { guild.roleId = role.id; return guild; });
      await interaction.reply({ content: `${role} is now the Song of the Day role.`, ephemeral: true });
    } else if (interaction.commandName === 'assign-sotd-channel') {
      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased() || channel.isDMBased()) {
        await interaction.reply({ content: 'Please choose a server text channel or thread.', ephemeral: true });
        return;
      }
      if (channel.isThread() && (channel.archived || channel.locked)) {
        await interaction.reply({ content: 'That thread is archived or locked. Choose an active thread.', ephemeral: true });
        return;
      }
      updateGuild(interaction.guildId, (guild) => { guild.channelId = channel.id; return guild; });
      await interaction.reply({ content: `${channel} is now the Song of the Day posting destination.`, ephemeral: true });
    } else if (interaction.commandName === 'start-sotd-run') {
      await runSetup.open(interaction, config.timezone);
    } else if (['skip-song-selection', 'end-song-selection'].includes(interaction.commandName)) {
      const data = getGuild(interaction.guildId);
      if (data.run?.status !== 'collecting') {
        await interaction.reply({ content: 'There is no active song-selection period.', ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const result = await finishCollection(client, interaction.guildId);
      if (!result) {
        await interaction.editReply('The song-selection period was already closed.');
      } else if (result.submittedCount === 0) {
        await interaction.editReply(`Song selection ended. No songs were submitted, so the run ended. Excluded ${result.excludedCount} non-submitter(s).`);
      } else {
        await interaction.editReply(
          `Song selection ended. Scheduled ${result.submittedCount} submitted song(s) and excluded ${result.excludedCount} non-submitter(s). Posting begins at the next daily posting time.`
        );
      }
    } else if (interaction.commandName === 'end-run') {
      const data = getGuild(interaction.guildId);
      if (!data.run || data.run.status === 'ended') {
        await interaction.reply({ content: 'There is no active run.', ephemeral: true });
        return;
      }
      updateGuild(interaction.guildId, (guild) => { guild.run.status = 'ended'; guild.run.endedAt = new Date().toISOString(); return guild; });
      await interaction.reply(RUN_ENDED);
    } else if (interaction.commandName === 'skip-person') {
      const data = getGuild(interaction.guildId);
      if (data.run?.status !== 'presenting') {
        await interaction.reply({ content: 'There is no song currently being presented.', ephemeral: true });
        return;
      }
      const next = data.run.currentIndex + 1;
      if (next >= data.run.schedule.length) {
        updateGuild(interaction.guildId, (guild) => { guild.run.status = 'ended'; guild.run.endedAt = new Date().toISOString(); return guild; });
        await interaction.reply(RUN_ENDED);
      } else {
        updateGuild(interaction.guildId, (guild) => { guild.run.currentIndex = next; guild.run.nextPostAt = null; return guild; });
        await interaction.deferReply({ ephemeral: true });
        await postCurrent(client, interaction.guildId);
        await interaction.editReply('Skipped the current person and posted the next song.');
      }
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    const response = { content: 'Something went wrong while handling that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => null);
    else await interaction.reply(response).catch(() => null);
  }
});

client.login(config.token);
