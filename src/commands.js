const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

const managerOnly = PermissionFlagsBits.ManageGuild;

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('assign-sotd-role')
      .setDescription('Choose the role used for Song of the Day runs.')
      .addRoleOption((option) => option.setName('role').setDescription('The Song of the Day role').setRequired(true))
      .setDefaultMemberPermissions(managerOnly),
    new SlashCommandBuilder()
      .setName('assign-sotd-channel')
      .setDescription('Choose the text channel or thread where the bot posts songs.')
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('Song of the Day text channel or thread')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread
        )
        .setRequired(true))
      .setDefaultMemberPermissions(managerOnly),
    new SlashCommandBuilder()
      .setName('start-sotd-run')
      .setDescription('Start collecting songs from members of the configured role.')
      .setDefaultMemberPermissions(managerOnly),
    new SlashCommandBuilder()
      .setName('skip-song-selection')
      .setDescription('Close song submissions now and begin with submitted songs.')
      .setDefaultMemberPermissions(managerOnly),
    new SlashCommandBuilder()
      .setName('skip-person')
      .setDescription("Skip the current person's song and immediately post the next song.")
      .setDefaultMemberPermissions(managerOnly),
    new SlashCommandBuilder()
      .setName('end-run')
      .setDescription('End the current Song of the Day run.')
      .setDefaultMemberPermissions(managerOnly)
  ].map((command) => command.toJSON());
}

module.exports = { buildCommands };
