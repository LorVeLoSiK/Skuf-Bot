require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
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
  new SlashCommandBuilder().setName("balance").setDescription("Показать твой баланс монет"),
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

// ═══════════════════════════════════════════════
// ХЕЛПЕРЫ
// ═══════════════════════════════════════════════

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
        await logToChannel(
          guild,
          `🎉 <@${userId}> получил роль **${threshold.label}** за ${threshold.count}+ приглашённых!`
        );
      } catch (e) {
        console.error(`Не смог выдать роль ${threshold.roleId} юзеру ${userId}:`, e.message);
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

  // Запускаем таймер начисления монет за войс
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

// Заработок за время в войсе — тикает по таймеру, начисляет всем, кто сейчас в войсе
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

// ═══════════════════════════════════════════════
// ОБРАБОТКА СЛЭШ-КОМАНД
// ═══════════════════════════════════════════════

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  if (commandName === "balance") {
    const bal = getBalance(user.id);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription(`💰 У тебя на балансе: **${bal}** монет`),
      ],
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
    await interaction.reply(`✅ Забрал ежедневный бонус: **+${cfg.DAILY_AMOUNT}** монет`);
  }

  if (commandName === "shop") {
    const lines = cfg.SHOP_ITEMS.map(
      (item) => `\`${item.id}\` — **${item.name}** — ${item.price} монет`
    ).join("\n");
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🛒 Магазин Утопии")
          .setDescription(lines || "Магазин пуст")
          .setFooter({ text: "Купить: /buy item:ID" }),
      ],
    });
  }

  if (commandName === "buy") {
    const itemId = interaction.options.getString("item");
    const item = cfg.SHOP_ITEMS.find((i) => i.id === itemId);

    if (!item) {
      await interaction.reply({ content: "❌ Нет такого предмета. Смотри /shop", ephemeral: true });
      return;
    }

    const success = subtractBalance(user.id, item.price);
    if (!success) {
      await interaction.reply({
        content: `❌ Недостаточно монет. Нужно ${item.price}, у тебя ${getBalance(user.id)}`,
        ephemeral: true,
      });
      return;
    }

    try {
      const member = await interaction.guild.members.fetch(user.id);
      await member.roles.add(item.roleId);
      await interaction.reply(`✅ Купил **${item.name}**! Роль выдана.`);
    } catch (e) {
      addBalance(user.id, item.price); // возвращаем монеты, если роль не выдалась
      await interaction.reply({
        content: "❌ Не смог выдать роль (проверь права бота/ID роли). Монеты возвращены.",
        ephemeral: true,
      });
    }
  }

  if (commandName === "invites") {
    const count = db.inviterCounts[user.id] || 0;
    await interaction.reply(`🎯 Ты пригласил: **${count}** человек`);
  }

  if (commandName === "leaderboard") {
    const type = interaction.options.getString("type");
    let entries;
    let title;

    if (type === "coins") {
      entries = Object.entries(db.balances);
      title = "🏆 Топ по монетам";
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

    const lines = top10.map(([id, val], i) => `${i + 1}. <@${id}> — ${val}`).join("\n");
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(title).setDescription(lines)],
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
