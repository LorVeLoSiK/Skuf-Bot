// Простая база на JSON-файле — не нужно поднимать отдельный сервер БД.
// Для маленького/среднего сервера этого достаточно с запасом.
//
// ВАЖНО: на Railway/Render файловая система контейнера НЕ постоянная —
// при каждом передеплое всё стирается. Чтобы данные (баланс, инвайты) не
// слетали, нужно подключить постоянный диск (Volume) и указать его путь
// через переменную окружения DATA_DIR. Если DATA_DIR не задана — используется
// обычная папка проекта (данные будут слетать при передеплое, как раньше).

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "data.json");

// На случай если папка DATA_DIR ещё не существует
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      balances: {},        // userId -> число монет
      lastChatEarn: {},     // userId -> timestamp последнего заработка в чате
      lastDaily: {},         // userId -> timestamp последнего /daily
      inviterCounts: {},     // userId(того кто приглашал) -> число засчитанных инвайтов
      joinedVia: {},          // memberId(того кто зашёл) -> { inviterId, joinedAt }
      givenRoles: {},          // userId -> [roleId, roleId, ...] уже выданные пороговые роли (чтобы не выдавать повторно)
      recentInvites: {},        // userId(инвайтера) -> [{ userId, username, joinedAt }, ...] последние 5, новые сверху
      inviteCodeCache: {},       // guildId -> { code: uses } — снэпшот инвайтов для вычисления, кто кого пригласил
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

let db = loadDB();

// Миграция: если база создана до появления этого поля — добавляем его,
// чтобы не упасть на существующих данных (например, уже на Railway)
if (!db.recentInvites) {
  db.recentInvites = {};
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getBalance(userId) {
  return db.balances[userId] || 0;
}

function addBalance(userId, amount) {
  db.balances[userId] = (db.balances[userId] || 0) + amount;
  save();
  return db.balances[userId];
}

function subtractBalance(userId, amount) {
  const current = getBalance(userId);
  if (current < amount) return false;
  db.balances[userId] = current - amount;
  save();
  return true;
}

module.exports = { db, save, getBalance, addBalance, subtractBalance };
