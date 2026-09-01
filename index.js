require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const cfg = require("./config");
const { db, save, getBalance, addBalance, subtractBalance } = require("./db");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.GuildMember],
});

// ═══════════════════════════════════════════════
// СЛЭШ-КОМАНДЫ — регистрация
// ═══════════════════════════════════════════════

const commands = [
  new SlashCommandBuilder().setName("balance").setDescription("Показать твой баланс пива"),
  new SlashCommandBuilder().setName("daily").setDescription("Забрать ежедневный бонус"),
  new SlashCommandBuilder()
    .setName("shop")
    .setDescription("Показать магазин ролей"),
  new SlashCommandBuilder()
    .setName("buy")
    .setDescription("Купить предмет из магазина")
    .addStringOption((opt) =>
      opt.setName("item").setDescription("ID предмета из /shop").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("invites")
    .setDescription("Показать сколько людей ты пригласил"),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Топ по пиву или по инвайтам")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("Тип рейтинга")
        .setRequired(true)
        .addChoices(
          { name: "Пиво", value: "coins" },
          { name: "Инвайты", value: "invites" }
        )
    ),
  new SlashCommandBuilder()
    .setName("addcoins")
    .setDescription("[Админ] Выдать/списать пиво игроку")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Кому").setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("amount")
        .setDescription("Сколько пива (можно отрицательное число, чтобы списать)")
        .setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✅ Слэш-команды зарегистрированы");
  } catch (err) {
    console.error("Ошибка регистрации команд:", err);
  }
}

// Ищет товар по ID во всех категориях
function findShopItem(itemId) {
  for (const category of cfg.SHOP_CATEGORIES) {
    const item = category.items.find((i) => i.id === itemId);
    if (item) return { ...item, categoryId: category.id, categoryName: category.name };
  }
  return null;
}

// Строит выпадающее меню со списком категорий магазина
function buildCategoryMenu() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("shop_select_category")
    .setPlaceholder("Выбери категорию")
    .addOptions(
      cfg.SHOP_CATEGORIES.map((cat) => ({
        label: cat.name,
        value: cat.id,
        emoji: cat.emoji || undefined,
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

// Строит кнопки товаров внутри выбранной категории + кнопку "Назад"
function buildItemButtons(category) {
  const rows = [];
  let currentRow = new ActionRowBuilder();

  category.items.forEach((item, i) => {
    if (i > 0 && i % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_buy_${item.id}`)
        .setLabel(`${item.name} — ${item.price}`)
        .setEmoji(item.emoji || cfg.CURRENCY_EMOJI)
        .setStyle(ButtonStyle.Success)
    );
  });
  rows.push(currentRow);

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("shop_back")
        .setLabel("Назад к категориям")
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return rows;
}

async function logToChannel(guild, text) {
  if (!cfg.LOG_CHANNEL_ID) return;
  try {
    const channel = await guild.channels.fetch(cfg.LOG_CHANNEL_ID);
    if (channel) channel.send(text);
  } catch (e) {
    /* канал не найден — молча пропускаем */
  }
}

// Проверяет пороги инвайтов и выдаёт роли, которых ещё не было
async function checkInviteThresholds(guild, userId) {
  const count = db.inviterCounts[userId] || 0;
  const given = db.givenRoles[userId] || [];

  for (const threshold of cfg.INVITE_THRESHOLDS) {
    if (count >= threshold.count && !given.includes(threshold.roleId)) {
      try {
        const member = await guild.members.fetch(userId);
        await member.roles.add(threshold.roleId);
        given.push(threshold.roleId);
        db.givenRoles[userId] = given;
        save();
        addBalance(userId, threshold.coinReward || 0);
        await logToChannel(
          guild,
          `🎉 <@${userId}> получил роль **${threshold.label}** и +${threshold.coinReward || 0} ${cfg.CURRENCY_EMOJI} за ${threshold.count}+ приглашённых!`
        );
      } catch (e) {
        console.error(`Не смог выдать роль ${threshold.roleId} юзеру ${userId}:`, e.message);
      }
    }
  }
}

// Снимает роли, которые больше не заслужены — если счётчик инвайтов упал
// ниже порога (например, приглашённый вышел раньше LEAVE_PENALTY_DAYS)
async function revokeUnearnedRoles(guild, userId) {
  const count = db.inviterCounts[userId] || 0;
  const given = db.givenRoles[userId] || [];

  for (const threshold of cfg.INVITE_THRESHOLDS) {
    if (count < threshold.count && given.includes(threshold.roleId)) {
      try {
        const member = await guild.members.fetch(userId);
        await member.roles.remove(threshold.roleId);
        db.givenRoles[userId] = given.filter((id) => id !== threshold.roleId);
        save();
        addBalance(userId, -(threshold.coinReward || 0)); // может уйти в минус, это нормально
        await logToChannel(
          guild,
          `📉 <@${userId}> потерял роль **${threshold.label}** и −${threshold.coinReward || 0} ${cfg.CURRENCY_EMOJI} — счёт инвайтов упал ниже ${threshold.count}`
        );
      } catch (e) {
        // Юзер мог сам выйти с сервера — роль снимать не с кого, но пиво всё равно списываем
        db.givenRoles[userId] = given.filter((id) => id !== threshold.roleId);
        save();
        addBalance(userId, -(threshold.coinReward || 0));
        console.error(`Не смог снять роль ${threshold.roleId} у юзера ${userId}:`, e.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════
// СОБЫТИЯ
// ═══════════════════════════════════════════════

client.once("ready", async () => {
  console.log(`🤖 Бот запущен как ${client.user.tag}`);
  await registerCommands();

  // Снимаем снэпшот текущих инвайтов по всем гильдиям — нужен для вычисления,
  // кто по какому инвайту зашёл (Discord API не говорит это напрямую)
  for (const [, guild] of client.guilds.cache) {
    try {
      const invites = await guild.invites.fetch();
      db.inviteCodeCache[guild.id] = {};
      invites.forEach((inv) => {
        db.inviteCodeCache[guild.id][inv.code] = inv.uses;
      });
      save();
    } catch (e) {
      console.error(`Не смог получить инвайты для ${guild.name}:`, e.message);
    }
  }

  // Запускаем таймер начисления пива за войс
  setInterval(voiceEarnTick, cfg.VOICE_INTERVAL_MINUTES * 60 * 1000);
});

// Обновляем кэш при создании/удалении инвайта
client.on("inviteCreate", async (invite) => {
  if (!db.inviteCodeCache[invite.guild.id]) db.inviteCodeCache[invite.guild.id] = {};
  db.inviteCodeCache[invite.guild.id][invite.code] = invite.uses;
  save();
});

client.on("inviteDelete", async (invite) => {
  if (db.inviteCodeCache[invite.guild.id]) {
    delete db.inviteCodeCache[invite.guild.id][invite.code];
    save();
  }
});

// Новый участник — вычисляем, по какому инвайту зашёл
client.on("guildMemberAdd", async (member) => {
  try {
    const newInvites = await member.guild.invites.fetch();
    const oldCache = db.inviteCodeCache[member.guild.id] || {};

    let usedInvite = null;
    newInvites.forEach((inv) => {
      const oldUses = oldCache[inv.code] || 0;
      if (inv.uses > oldUses) {
        usedInvite = inv;
      }
    });

    // обновляем кэш в любом случае
    db.inviteCodeCache[member.guild.id] = {};
    newInvites.forEach((inv) => {
      db.inviteCodeCache[member.guild.id][inv.code] = inv.uses;
    });

    if (usedInvite && usedInvite.inviter) {
      const inviterId = usedInvite.inviter.id;
      db.inviterCounts[inviterId] = (db.inviterCounts[inviterId] || 0) + 1;
      db.joinedVia[member.id] = { inviterId, joinedAt: Date.now() };
      save();

      await checkInviteThresholds(member.guild, inviterId);
    } else {
      save();
    }
  } catch (e) {
    console.error("Ошибка обработки guildMemberAdd:", e.message);
  }
});

// Участник вышел — если вышел раньше LEAVE_PENALTY_DAYS, снимаем инвайт с реферера
client.on("guildMemberRemove", async (member) => {
  const joinInfo = db.joinedVia[member.id];
  if (!joinInfo) return;

  const daysSinceJoin = (Date.now() - joinInfo.joinedAt) / (1000 * 60 * 60 * 24);
  if (daysSinceJoin < cfg.LEAVE_PENALTY_DAYS) {
    const inviterId = joinInfo.inviterId;
    db.inviterCounts[inviterId] = Math.max(0, (db.inviterCounts[inviterId] || 0) - 1);
    delete db.joinedVia[member.id];
    save();
    await logToChannel(
      member.guild,
      `⚠️ <@${member.id}> вышел раньше ${cfg.LEAVE_PENALTY_DAYS} дней — инвайт снят с <@${inviterId}>`
    );
    await revokeUnearnedRoles(member.guild, inviterId);
  }
});

// Заработок за сообщения в чате
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const now = Date.now();
  const last = db.lastChatEarn[userId] || 0;

  if (now - last >= cfg.CHAT_COOLDOWN_SEC * 1000) {
    const amount =
      Math.floor(Math.random() * (cfg.CHAT_EARN_MAX - cfg.CHAT_EARN_MIN + 1)) + cfg.CHAT_EARN_MIN;
    addBalance(userId, amount);
    db.lastChatEarn[userId] = now;
    save();
  }
});

// Заработок за время в войсе — тикает по таймеру, начисляет пиво всем, кто сейчас в войсе
function voiceEarnTick() {
  for (const [, guild] of client.guilds.cache) {
    guild.channels.cache.forEach((channel) => {
      if (!channel.isVoiceBased()) return;
      if (cfg.VOICE_IGNORE_AFK && channel.id === guild.afkChannelId) return;

      const humanMembers = channel.members.filter((m) => !m.user.bot);
      if (cfg.VOICE_REQUIRE_NOT_ALONE && humanMembers.size < 2) return;

      humanMembers.forEach((member) => {
        if (cfg.VOICE_IGNORE_MUTED_DEAFENED) {
          const state = member.voice;
          if (state.selfMute || state.selfDeaf || state.serverMute || state.serverDeaf) return;
        }
        addBalance(member.id, cfg.VOICE_EARN_AMOUNT);
      });
    });
  }
}

// Общая логика покупки — используется и командой /buy, и кнопками в магазине
async function purchaseItem(interaction, item) {
  const userId = interaction.user.id;
  const success = subtractBalance(userId, item.price);

  if (!success) {
    await interaction.reply({
      content: `❌ Недостаточно пива. Нужно ${item.price} ${cfg.CURRENCY_EMOJI}, у тебя ${getBalance(userId)} ${cfg.CURRENCY_EMOJI}`,
      ephemeral: true,
    });
    return;
  }

  try {
    const member = await interaction.guild.members.fetch(userId);
    await member.roles.add(item.roleId);
    await interaction.reply({ content: `✅ Купил **${item.name}**! Роль выдана.`, ephemeral: true });
  } catch (e) {
    addBalance(userId, item.price); // возвращаем пиво, если роль не выдалась
    await interaction.reply({
      content: "❌ Не смог выдать роль (проверь права бота/ID роли). Пиво возвращено.",
      ephemeral: true,
    });
  }
}

// ═══════════════════════════════════════════════
// ОБРАБОТКА СЛЭШ-КОМАНД
// ═══════════════════════════════════════════════

client.on("interactionCreate", async (interaction) => {
  // Выбор категории в выпадающем меню магазина
  if (interaction.isStringSelectMenu() && interaction.customId === "shop_select_category") {
    const categoryId = interaction.values[0];
    const category = cfg.SHOP_CATEGORIES.find((c) => c.id === categoryId);
    if (!category) return;

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`${category.emoji || ""} ${category.name}`.trim())
          .setDescription("Нажми на кнопку, чтобы купить."),
      ],
      components: buildItemButtons(category),
    });
    return;
  }

  // Кнопка "Назад к категориям"
  if (interaction.isButton() && interaction.customId === "shop_back") {
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🛒 Магазин Утопии")
          .setDescription("Выбери категорию ниже, чтобы посмотреть товары."),
      ],
      components: [buildCategoryMenu()],
    });
    return;
  }

  // Кнопка покупки конкретного товара
  if (interaction.isButton() && interaction.customId.startsWith("shop_buy_")) {
    const itemId = interaction.customId.replace("shop_buy_", "");
    const item = findShopItem(itemId);
    if (!item) {
      await interaction.reply({ content: "❌ Товар не найден.", ephemeral: true });
      return;
    }
    await purchaseItem(interaction, item);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  if (commandName === "balance") {
    const bal = getBalance(user.id);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription(`${cfg.CURRENCY_EMOJI} У тебя на балансе: **${bal}** пива`),
      ],
      ephemeral: true,
    });
  }

  if (commandName === "daily") {
    const now = Date.now();
    const last = db.lastDaily[user.id] || 0;
    const dayMs = 24 * 60 * 60 * 1000;

    if (now - last < dayMs) {
      const hoursLeft = Math.ceil((dayMs - (now - last)) / (1000 * 60 * 60));
      await interaction.reply({
        content: `⏳ Уже забирал сегодня. Приходи через ~${hoursLeft} ч.`,
        ephemeral: true,
      });
      return;
    }

    addBalance(user.id, cfg.DAILY_AMOUNT);
    db.lastDaily[user.id] = now;
    save();
    await interaction.reply(`✅ Забрал ежедневный бонус: **+${cfg.DAILY_AMOUNT}** пива ${cfg.CURRENCY_EMOJI}`);
  }

  if (commandName === "shop") {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🛒 Магазин Утопии")
          .setDescription("Выбери категорию ниже, чтобы посмотреть товары."),
      ],
      components: [buildCategoryMenu()],
    });
  }

  if (commandName === "buy") {
    const itemId = interaction.options.getString("item");
    const item = findShopItem(itemId);

    if (!item) {
      await interaction.reply({ content: "❌ Нет такого предмета. Смотри /shop", ephemeral: true });
      return;
    }

    await purchaseItem(interaction, item);
  }

  if (commandName === "invites") {
    const count = db.inviterCounts[user.id] || 0;
    await interaction.reply({ content: `🎯 Ты пригласил: **${count}** человек`, ephemeral: true });
  }

  if (commandName === "addcoins") {
    // Двойная проверка прав — на случай если кто-то вызовет команду в обход UI Discord
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: "❌ Эта команда только для администраторов.",
        ephemeral: true,
      });
      return;
    }

    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");

    const newBalance = addBalance(target.id, amount);

    await interaction.reply(
      `✅ ${amount >= 0 ? "Выдано" : "Списано"} **${Math.abs(amount)}** пива ${cfg.CURRENCY_EMOJI} для <@${target.id}>. Новый баланс: **${newBalance}** ${cfg.CURRENCY_EMOJI}`
    );
  }

  if (commandName === "leaderboard") {
    const type = interaction.options.getString("type");
    let entries;
    let title;

    if (type === "coins") {
      entries = Object.entries(db.balances);
      title = `🏆 Топ по пиву ${cfg.CURRENCY_EMOJI}`;
    } else {
      entries = Object.entries(db.inviterCounts);
      title = "🏆 Топ по инвайтам";
    }

    entries.sort((a, b) => b[1] - a[1]);
    const top10 = entries.slice(0, 10);

    if (top10.length === 0) {
      await interaction.reply("Пока пусто.");
      return;
    }

    const suffix = type === "coins" ? ` ${cfg.CURRENCY_EMOJI}` : "";
    const lines = top10.map(([id, val], i) => `${i + 1}. <@${id}> — ${val}${suffix}`).join("\n");
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(title).setDescription(lines)],
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
