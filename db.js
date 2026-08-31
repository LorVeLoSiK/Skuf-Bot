// Простая база на JSON-файле — не нужно поднимать отдельный сервер БД.
// Для маленького/среднего сервера этого достаточно с запасом.

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      balances: {},        // userId -> число монет
      lastChatEarn: {},     // userId -> timestamp последнего заработка в чате
      lastDaily: {},         // userId -> timestamp последнего /daily
      inviterCounts: {},     // userId(того кто приглашал) -> число засчитанных инвайтов
      joinedVia: {},          // memberId(того кто зашёл) -> { inviterId, joinedAt }
      givenRoles: {},          // userId -> [roleId, roleId, ...] уже выданные пороговые роли (чтобы не выдавать повторно)
      inviteCodeCache: {},       // guildId -> { code: uses } — снэпшот инвайтов для вычисления, кто кого пригласил
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

let db = loadDB();

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
