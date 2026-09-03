const { randomUUID } = require('node:crypto');
const {
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { DEFAULT_TIMEZONE, hourlyTime, nextSelectionDeadline, nextDaily } = require('./schedule');

const SETUP_TTL = 15 * 60 * 1000;
const SELECTION_MODAL_ID = 'sotd-selection-date';
const PREFIX = 'sotd-setup:';

function numberInput(id, label, placeholder) {
  return new LabelBuilder().setLabel(label).setTextInputComponent(new TextInputBuilder()
    .setCustomId(id).setStyle(TextInputStyle.Short).setPlaceholder(placeholder)
    .setMinLength(1).setMaxLength(2).setRequired(true));
}

function dropdown(id, label, values, timezone) {
  return new LabelBuilder().setLabel(label).setDescription(`Timezone: ${timezone}. Whole hours only.`)
    .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId(id)
      .setPlaceholder(label).setMinValues(1).setMaxValues(1).setRequired(true)
      .addOptions(values.map(value => ({ label: String(value), value: String(value) }))));
}

function timeInputs(prefix, timezone) {
  return [
    dropdown(`${prefix}-hour`, 'Hour (1–12)', Array.from({ length: 12 }, (_, i) => i + 1), timezone),
    dropdown(`${prefix}-period`, 'AM or PM', ['AM', 'PM'], timezone)
  ];
}

function selectionModal(timezone) {
  return new ModalBuilder().setCustomId(SELECTION_MODAL_ID).setTitle('1. Song selection ends')
    .addLabelComponents(
      numberInput('selection-month', 'Month (1–12)', 'Example: 9 for September'),
      numberInput('selection-day', 'Day of the month (1–31)', 'Example: 5'),
      ...timeInputs('selection', timezone)
    );
}

function selected(fields, id) {
  const values = fields.getStringSelectValues(id);
  if (values.length !== 1) throw new Error('Choose one value in each time dropdown.');
  return values[0];
}

function createRunSetup() {
  const drafts = new Map();
  function cleanup() {
    for (const [id, draft] of drafts) if (draft.expiresAt <= Date.now()) drafts.delete(id);
  }
  async function error(interaction, content) {
    await interaction.reply({ content, ephemeral: true });
    return null;
  }

  return {
    matches: interaction => interaction.customId === SELECTION_MODAL_ID || interaction.customId?.startsWith(PREFIX),
    async open(interaction, timezone = DEFAULT_TIMEZONE) {
      cleanup();
      await interaction.showModal(selectionModal(timezone));
    },
    async handle(interaction, timezone = DEFAULT_TIMEZONE) {
      cleanup();
      if (interaction.customId === SELECTION_MODAL_ID && interaction.isModalSubmit()) {
        let deadline;
        try {
          deadline = nextSelectionDeadline(
            interaction.fields.getTextInputValue('selection-month'), interaction.fields.getTextInputValue('selection-day'),
            selected(interaction.fields, 'selection-hour'), selected(interaction.fields, 'selection-period'), Date.now(), timezone
          );
        } catch (cause) {
          return error(interaction, `${cause.message} Reopen /start-sotd-run to try again.`);
        }
        for (const [id, draft] of drafts) {
          if (draft.userId === interaction.user.id && draft.guildId === interaction.guildId) drafts.delete(id);
        }
        const id = randomUUID();
        drafts.set(id, { userId: interaction.user.id, guildId: interaction.guildId, timezone,
          deadline: deadline.toISOString(), expiresAt: Date.now() + SETUP_TTL, announcementOpened: false });
        await interaction.reply({
          content: `Song selection will end <t:${Math.floor(deadline.getTime() / 1000)}:F> (${timezone}).\n` +
            'Next, choose the daily announcement hour. No run or invitations are created until you submit that choice.',
          ephemeral: true,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${PREFIX}announcement:${id}`).setLabel('Choose announcement time').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`${PREFIX}cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
          )]
        });
        return null;
      }
      const match = interaction.customId?.match(/^sotd-setup:(announcement|confirm|cancel):([a-f0-9-]+)$/);
      if (!match) return error(interaction, 'Please reopen /start-sotd-run to use the scheduling form.');
      const [, action, id] = match;
      const draft = drafts.get(id);
      if (!draft) return error(interaction, 'This setup expired or was already used. Reopen /start-sotd-run.');
      if (draft.userId !== interaction.user.id || draft.guildId !== interaction.guildId) {
        return error(interaction, 'Only the member who opened this setup can use it in this server.');
      }
      if (action === 'cancel' && interaction.isButton()) {
        drafts.delete(id);
        await interaction.update({ content: 'Song of the Day setup cancelled.', components: [] });
        return null;
      }
      if (Date.parse(draft.deadline) <= Date.now()) {
        drafts.delete(id);
        return error(interaction, 'The selected end time has passed. Reopen /start-sotd-run to choose another date/time.');
      }
      if (action === 'announcement' && interaction.isButton()) {
        const modal = new ModalBuilder().setCustomId(`${PREFIX}confirm:${id}`).setTitle('2. Daily song announcement')
          .addLabelComponents(...timeInputs('announcement', draft.timezone));
        draft.announcementOpened = true;
        await interaction.showModal(modal);
        return null;
      }
      if (action === 'confirm' && interaction.isModalSubmit() && draft.announcementOpened) {
        let dailyTime;
        try {
          dailyTime = hourlyTime(selected(interaction.fields, 'announcement-hour'), selected(interaction.fields, 'announcement-period'));
          nextDaily(dailyTime, draft.timezone);
        } catch (cause) {
          return error(interaction, `${cause.message} Click Choose announcement time to try again.`);
        }
        // Consume before any network calls so replayed submits cannot start twice.
        drafts.delete(id);
        return { deadline: new Date(draft.deadline), dailyTime, timezone: draft.timezone };
      }
      return error(interaction, 'Please use the buttons and dropdowns in your current setup.');
    }
  };
}

module.exports = { createRunSetup, SELECTION_MODAL_ID, SETUP_TTL };
