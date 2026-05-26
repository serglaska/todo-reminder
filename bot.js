require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('[ERROR] BOT_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new Telegraf(TOKEN);

const DATA_DIR = path.join(__dirname, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TIMEOUT_MS = 15 * 60 * 1000;

// ─── Data helpers ─────────────────────────────────────────────────────────────

function readJSON(file, def) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(def, null, 2));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return def;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readTodos() {
  const raw = readJSON(TODOS_FILE, { current: [], global: [] });
  // migrate old flat-array format → current list
  if (Array.isArray(raw)) {
    const migrated = { current: raw, global: [] };
    writeJSON(TODOS_FILE, migrated);
    return migrated;
  }
  if (!raw.current) raw.current = [];
  if (!raw.global)  raw.global  = [];
  return raw;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

// ─── In-memory state ──────────────────────────────────────────────────────────

const userStates      = {};  // chatId -> 'awaiting_todo'
const userActiveList  = {};  // chatId -> 'current' | 'global'
const selections      = {};  // chatId -> Set of todo IDs

const stateTimeouts     = {};
const selectionTimeouts = {};

function getActiveList(chatId) {
  return userActiveList[chatId] || 'current';
}

function setUserState(chatId, state) {
  if (stateTimeouts[chatId]) clearTimeout(stateTimeouts[chatId]);
  userStates[chatId] = state;
  stateTimeouts[chatId] = setTimeout(() => {
    delete userStates[chatId];
    delete stateTimeouts[chatId];
    log('INFO', `State timeout cleared for chat ${chatId}`);
  }, TIMEOUT_MS);
}

function clearUserState(chatId) {
  if (stateTimeouts[chatId]) {
    clearTimeout(stateTimeouts[chatId]);
    delete stateTimeouts[chatId];
  }
  delete userStates[chatId];
}

function setSelection(chatId, set) {
  if (selectionTimeouts[chatId]) clearTimeout(selectionTimeouts[chatId]);
  selections[chatId] = set;
  selectionTimeouts[chatId] = setTimeout(() => {
    delete selections[chatId];
    delete selectionTimeouts[chatId];
    log('INFO', `Selection timeout cleared for chat ${chatId}`);
  }, TIMEOUT_MS);
}

function clearSelection(chatId) {
  if (selectionTimeouts[chatId]) {
    clearTimeout(selectionTimeouts[chatId]);
    delete selectionTimeouts[chatId];
  }
  delete selections[chatId];
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

function numLabel(i) {
  return i < NUM_EMOJI.length ? NUM_EMOJI[i] : `${i + 1}.`;
}

function escMd(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

const LIST_META = {
  current: { label: 'Поточні задачі', emoji: '📋' },
  global:  { label: 'Глобальні задачі', emoji: '🌐' },
};

function formatList(todos, listType) {
  const { label, emoji } = LIST_META[listType];
  const header = escMd(`${emoji} ${label}`);
  if (!todos.length) return `📭 *${header}* порожній\\!`;
  const items = todos.map((t, i) => `${numLabel(i)} ${escMd(t.text)}`).join('\n');
  return `*${header}:*\n\n${items}\n\n💪 *Зроби це\\!* 🚀`;
}

function formatDailyReminder(todos) {
  const items = todos.map((t, i) => `${numLabel(i)} ${escMd(t.text)}`).join('\n');
  return (
    `🌞 *Доброго дня\\! Час не чекає\\!*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${items}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💪 Виконай все до кінця дня\\! 🎯`
  );
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

const MAIN_KEYBOARD = Markup.keyboard([
  ['➕ Додати', '🗑 Видалити'],
  ['📋 Поточні', '🌐 Глобальні'],
]).resize().persistent();

function deleteKeyboard(todos, selected) {
  const rows = todos.map(t =>
    [Markup.button.callback(
      `${selected.has(t.id) ? '✅' : '⬜️'} ${t.text}`,
      `t:${t.id}`
    )]
  );
  rows.push([
    Markup.button.callback('🗑 Підтвердити', 'del:confirm'),
    Markup.button.callback('❌ Скасувати',   'del:cancel'),
  ]);
  return Markup.inlineKeyboard(rows);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.start(ctx => {
  const chatId = ctx.chat.id;
  const users = readJSON(USERS_FILE, { active: [] });

  if (!users.active.includes(chatId)) {
    users.active.push(chatId);
    writeJSON(USERS_FILE, users);
    log('INFO', `User ${ctx.from.id} (@${ctx.from.username || 'unknown'}) activated the bot`);
  }

  return ctx.replyWithMarkdownV2(
    '👋 *Привіт\\! Я твій Todo\\-бот\\!*\n\n' +
    '⏰ Щодня о *13:00* надсилаю нагадування з *поточними* задачами\\.\n\n' +
    '📋 *Поточні* — справи на зараз\n' +
    '🌐 *Глобальні* — довгострокові цілі\n\n' +
    '📌 *Команди:*\n' +
    '/start — активувати бота\n' +
    '/stop  — зупинити нагадування\n' +
    '/list  — показати активний список',
    MAIN_KEYBOARD
  );
});

bot.command('stop', ctx => {
  const chatId = ctx.chat.id;
  const users = readJSON(USERS_FILE, { active: [] });
  users.active = users.active.filter(id => id !== chatId);
  writeJSON(USERS_FILE, users);
  clearUserState(chatId);
  clearSelection(chatId);
  log('INFO', `User ${ctx.from.id} deactivated the bot`);

  return ctx.replyWithMarkdownV2(
    '😴 *Бот зупинено\\.* Нагадування більше не надходитимуть\\.\n\nДля активації знову — /start',
    Markup.removeKeyboard()
  );
});

bot.command('list', ctx => sendActiveList(ctx));

// ─── Button handlers ──────────────────────────────────────────────────────────

bot.hears('➕ Додати', ctx => {
  const chatId = ctx.chat.id;
  const listType = getActiveList(chatId);
  const { label, emoji } = LIST_META[listType];
  setUserState(chatId, 'awaiting_todo');
  return ctx.replyWithMarkdownV2(
    `✏️ *Введи текст завдання для ${escMd(emoji + ' ' + label)}:*`,
    Markup.forceReply()
  );
});

bot.hears('🗑 Видалити', ctx => {
  const chatId = ctx.chat.id;
  const listType = getActiveList(chatId);
  const todos = readTodos();
  const list = todos[listType];
  const { label, emoji } = LIST_META[listType];

  if (!list.length) {
    return ctx.reply(`📭 ${emoji} ${label} порожній, нема що видаляти!`, MAIN_KEYBOARD);
  }

  setSelection(chatId, new Set());
  return ctx.replyWithMarkdownV2(
    `🗑 *Обери завдання для видалення з ${escMd(emoji + ' ' + label)}:*`,
    deleteKeyboard(list, selections[chatId])
  );
});

bot.hears('📋 Поточні', ctx => {
  userActiveList[ctx.chat.id] = 'current';
  return sendActiveList(ctx);
});

bot.hears('🌐 Глобальні', ctx => {
  userActiveList[ctx.chat.id] = 'global';
  return sendActiveList(ctx);
});

// ─── Message handler ──────────────────────────────────────────────────────────

bot.on('text', ctx => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  if (userStates[chatId] === 'awaiting_todo') {
    const listType = getActiveList(chatId);
    const todos = readTodos();
    const todo = {
      id: Date.now().toString(),
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };
    todos[listType].push(todo);
    writeJSON(TODOS_FILE, todos);
    clearUserState(chatId);
    log('INFO', `Todo added by user ${ctx.from.id} to ${listType}: "${todo.text}"`);

    const { label, emoji } = LIST_META[listType];
    return ctx.replyWithMarkdownV2(
      `✅ *Додано до ${escMd(emoji + ' ' + label)}:*\n📌 ${escMd(todo.text)}`,
      MAIN_KEYBOARD
    );
  }
});

// ─── Inline button callbacks ──────────────────────────────────────────────────

bot.action(/^t:(.+)$/, async ctx => {
  const chatId = ctx.chat.id;
  const id = ctx.match[1];

  if (!selections[chatId]) setSelection(chatId, new Set());

  if (selections[chatId].has(id)) selections[chatId].delete(id);
  else selections[chatId].add(id);

  const todos = readTodos();
  const listType = getActiveList(chatId);
  await ctx.editMessageReplyMarkup(deleteKeyboard(todos[listType], selections[chatId]).reply_markup);
  return ctx.answerCbQuery();
});

bot.action('del:confirm', async ctx => {
  const chatId = ctx.chat.id;
  const selected = selections[chatId] || new Set();

  if (!selected.size) {
    return ctx.answerCbQuery('⚠️ Нічого не вибрано!');
  }

  const listType = getActiveList(chatId);
  const todos = readTodos();
  const removed = todos[listType].filter(t => selected.has(t.id));
  todos[listType] = todos[listType].filter(t => !selected.has(t.id));
  writeJSON(TODOS_FILE, todos);
  clearSelection(chatId);

  log('INFO', `User ${ctx.from.id} deleted ${removed.length} todo(s) from ${listType}`);

  const removedText = removed.map(t => `• ${escMd(t.text)}`).join('\n');
  await ctx.editMessageText(
    `🗑 *Видалено \\(${removed.length} шт\\.\\):*\n\n${removedText}`,
    { parse_mode: 'MarkdownV2' }
  );
  await ctx.reply('✅ Готово!', MAIN_KEYBOARD);
  return ctx.answerCbQuery();
});

bot.action('del:cancel', async ctx => {
  clearSelection(ctx.chat.id);
  await ctx.editMessageText('❌ Видалення скасовано.');
  await ctx.reply('👍 Скасовано.', MAIN_KEYBOARD);
  return ctx.answerCbQuery();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendActiveList(ctx) {
  const chatId = ctx.chat.id;
  const listType = getActiveList(chatId);
  const todos = readTodos();
  return ctx.replyWithMarkdownV2(formatList(todos[listType], listType), MAIN_KEYBOARD);
}

// ─── Daily reminder @ 13:00 Kyiv ─────────────────────────────────────────────

cron.schedule('0 13 * * *', () => {
  const todos = readTodos();
  const users = readJSON(USERS_FILE, { active: [] });

  if (!todos.current.length) {
    log('INFO', 'Daily reminder: current list is empty, skipping');
    return;
  }

  log('INFO', `Daily reminder: sending to ${users.active.length} user(s)`);

  const message = formatDailyReminder(todos.current);

  users.active.forEach(chatId => {
    bot.telegram.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' })
      .catch(err => log('ERROR', `Failed to send to chat ${chatId}: ${err.message}`));
  });
}, { timezone: 'Europe/Kiev' });

// ─── Start ────────────────────────────────────────────────────────────────────

bot.launch();

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

log('INFO', '🤖 Todo-bot started successfully');
