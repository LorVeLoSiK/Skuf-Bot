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
  AttachmentBuilder,
} = require("discord.js");
const path = require("path");
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

// Собирает главный экран магазина (список категорий) — с баннером и футером.
// Используется и командой /shop, и кнопкой "Назад к категориям"
function buildShopHome() {
  const banner = new AttachmentBuilder(path.join(__dirname, "assets", "shop_banner.jpg"), {
    name: "shop_banner.jpg",
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🍻 Таверна Утопии")
    .setDescription(
      "Заходи, скуф, грей кости у очага.\nЗдесь за пиво меняют не только хмель — но и уважение орды.\n\nВыбирай полку ниже."
    )
    .setImage("attachment://shop_banner.jpg")
    .setFooter({ text: "Проверить загашник: /balance" });

  return { embeds: [embed], components: [buildCategoryMenu()], files: [banner] };
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
        .setLabel(`${item.name} — ${item.price} 🍺`)
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
          `🎉 <@${userId}> прошёл путь и получил роль **${threshold.label}** + ${threshold.coinReward || 0} ${cfg.CURRENCY_EMOJI} за ${threshold.count}+ приглашённых! Слава Орде!`
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
          `📉 <@${userId}> оступился — роль **${threshold.label}** и ${threshold.coinReward || 0} ${cfg.CURRENCY_EMOJI} изъяты, счёт вербовки упал ниже ${threshold.count}`
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

      // Добавляем в список последних приглашённых — новые сверху, храним максимум 5
      if (!db.recentInvites[inviterId]) db.recentInvites[inviterId] = [];
      db.recentInvites[inviterId].unshift({
        userId: member.id,
        username: member.user.username,
        joinedAt: Date.now(),
      });
      db.recentInvites[inviterId] = db.recentInvites[inviterId].slice(0, 5);

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
    if (db.recentInvites[inviterId]) {
      db.recentInvites[inviterId] = db.recentInvites[inviterId].filter(
        (entry) => entry.userId !== member.id
      );
    }
    save();
    await logToChannel(
      member.guild,
      `⚠️ <@${member.id}> сбежал из Орды раньше ${cfg.LEAVE_PENALTY_DAYS} дней — инвайт снят с <@${inviterId}>`
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

  // Проверяем, нет ли уже этой роли — до списания денег
  const member = await interaction.guild.members.fetch(userId);
  if (member.roles.cache.has(item.roleId)) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xfee75c)
          .setDescription(`😏 Эту роль ты уже носишь, скуф. Дважды в одну реку не входят — глянь остальное.`),
      ],
      ephemeral: true,
    });
    return;
  }

  const success = subtractBalance(userId, item.price);

  if (!success) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("🪙 Кошелёк пустой")
          .setDescription(
            `Нужно **${item.price}** ${cfg.CURRENCY_EMOJI}, а у тебя всего **${getBalance(userId)}** ${cfg.CURRENCY_EMOJI}.\n\nЗарабатывай в чате, зависай в войсе или тащи корешей по рефералке — /invites.`
          ),
      ],
      ephemeral: true,
    });
    return;
  }

  try {
    await member.roles.add(item.roleId);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("🎉 Куплено!")
          .setDescription(`Забрал **${item.name}** — теперь вся Орда видит, кто тут в авторитете.`),
      ],
      ephemeral: true,
    });
  } catch (e) {
    addBalance(userId, item.price); // возвращаем пиво, если роль не выдалась
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("⚠️ Бармен затупил")
          .setDescription(
            "Не смог выдать роль (проверь права бота или ID роли в конфиге). Пиво вернул на счёт."
          ),
      ],
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
          .setDescription("Разряжай кошелёк, скуф — выбирай, чем гордиться перед братвой")
          .setFooter({ text: "Проверить загашник: /balance" }),
      ],
      components: buildItemButtons(category),
      files: [],
    });
    return;
  }

  // Кнопка "Назад к категориям"
  if (interaction.isButton() && interaction.customId === "shop_back") {
    await interaction.update(buildShopHome());
    return;
  }

  // Кнопка покупки конкретного товара
  if (interaction.isButton() && interaction.customId.startsWith("shop_buy_")) {
    const itemId = interaction.customId.replace("shop_buy_", "");
    const item = findShopItem(itemId);
    if (!item) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription("🤷 Такого товара тут нет. Может, полка обвалилась — глянь /shop заново."),
        ],
        ephemeral: true,
      });
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
          .setTitle("🍺 Твой загашник")
          .setDescription(
            `В кармане звенит: **${bal}** ${cfg.CURRENCY_EMOJI}\n\nКопи на роль мечты или спускай в таверне — дело хозяйское.`
          ),
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
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle("⏳ Не гони, скуф")
            .setDescription(`Пайку на сегодня уже забрал. Трактирщик нальёт ещё через ~${hoursLeft} ч.`),
        ],
        ephemeral: true,
      });
      return;
    }

    addBalance(user.id, cfg.DAILY_AMOUNT);
    db.lastDaily[user.id] = now;
    save();
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("🎁 Дневная пайка")
          .setDescription(
            `Затарился на сегодня: **+${cfg.DAILY_AMOUNT}** ${cfg.CURRENCY_EMOJI}\n\nЗаходи завтра — халява в Утопии не кончается.`
          ),
      ],
      ephemeral: true,
    });
  }

  if (commandName === "shop") {
    await interaction.reply({ ...buildShopHome(), ephemeral: true });
  }

  if (commandName === "buy") {
    const itemId = interaction.options.getString("item");
    const item = findShopItem(itemId);

    if (!item) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription("🤷 Такого товара тут нет. Может, полка обвалилась — глянь /shop заново."),
        ],
        ephemeral: true,
      });
      return;
    }

    await purchaseItem(interaction, item);
  }

  if (commandName === "invites") {
    const count = db.inviterCounts[user.id] || 0;
    const recent = db.recentInvites[user.id] || [];

    const lines = [];
    for (let i = 0; i < 5; i++) {
      if (recent[i]) {
        lines.push(`${i + 1}. **${recent[i].username}**`);
      } else {
        lines.push(`${i + 1}. —`);
      }
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🎯 Твоя вербовка")
          .setDescription(
            `Затащил в Орду: **${count}** человек\n\n**Последние 5 рекрутов:**\n${lines.join("\n")}`
          )
          .setFooter({ text: "Больше народу — больше движухи. Тащи ещё!" }),
      ],
      ephemeral: true,
    });
  }

  if (commandName === "addcoins") {
    // Двойная проверка прав — на случай если кто-то вызовет команду в обход UI Discord
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription("🚫 Эта команда не для рядовых скуфов — только для админов Утопии."),
        ],
        ephemeral: true,
      });
      return;
    }

    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");

    const newBalance = addBalance(target.id, amount);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("🍺 Казначейство Утопии")
          .setDescription(
            `${amount >= 0 ? "Налито" : "Слито"} **${Math.abs(amount)}** ${cfg.CURRENCY_EMOJI} для <@${target.id}>.\nНовый баланс: **${newBalance}** ${cfg.CURRENCY_EMOJI}`
          ),
      ],
      ephemeral: true,
    });
  }

  if (commandName === "leaderboard") {
    await interaction.deferReply({ ephemeral: true });

    const type = interaction.options.getString("type");
    let entries;
    let title;

    if (type === "coins") {
      entries = Object.entries(db.balances);
      title = `🏆 Хранители пивного трона`;
    } else {
      entries = Object.entries(db.inviterCounts);
      title = "🏆 Вербовщики Орды";
    }

    entries.sort((a, b) => b[1] - a[1]);

    // Убираем из лидерборда админов сервера — проверяем по очереди, пока не
    // наберём 10 обычных участников (или пока не кончится список)
    const filtered = [];
    for (const entry of entries) {
      if (filtered.length >= 10) break;
      try {
        const member = await interaction.guild.members.fetch(entry[0]);
        if (member.permissions.has(PermissionFlagsBits.Administrator)) continue;
        filtered.push(entry);
      } catch (e) {
        // юзера больше нет на сервере — пропускаем
      }
    }

    if (filtered.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xfee75c)
            .setDescription("Тут пока пусто. Будь первым, кто впишет своё имя в историю Утопии."),
        ],
      });
      return;
    }

    const suffix = type === "coins" ? ` ${cfg.CURRENCY_EMOJI}` : "";
    const lines = filtered.map(([id, val], i) => `${i + 1}. <@${id}> — ${val}${suffix}`).join("\n");
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle(title)
          .setDescription(lines)
          .setFooter({ text: "Скуфы с админкой в топ не допускаются — по-честному" }),
      ],
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
