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

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

// ─── In-memory state ──────────────────────────────────────────────────────────

const userStates = {};  // chatId -> 'awaiting_todo'
const selections = {};  // chatId -> Set of todo IDs

// ─── Formatting ───────────────────────────────────────────────────────────────

const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

function numLabel(i) {
  return i < NUM_EMOJI.length ? NUM_EMOJI[i] : `${i + 1}.`;
}

function formatList(todos) {
  if (!todos.length) return '📭 Список завдань порожній!';
  const items = todos.map((t, i) => `${numLabel(i)} ${t.text}`).join('\n');
  return `📋 *Твій список справ:*\n\n${items}\n\n💪 *Зроби це сьогодні\\!* 🚀`;
}

function formatDailyReminder(todos) {
  const items = todos.map((t, i) => `${numLabel(i)} ${t.text}`).join('\n');
  return (
    `🌞 *Доброго дня\\! Час не чекає\\!*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${items}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💪 Виконай все до кінця дня\\! 🎯`
  );
}

// Escape special MarkdownV2 chars in user text
function escMd(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

const MAIN_KEYBOARD = Markup.keyboard([
  ['➕ Додати', '🗑 Видалити'],
  ['📋 Список'],
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
    '⏰ Щодня о *13:00* я надішлю тобі нагадування зі списком справ\\.\n\n' +
    '📌 *Команди:*\n' +
    '/start — активувати бота\n' +
    '/stop  — зупинити нагадування\n' +
    '/list  — показати список зараз',
    MAIN_KEYBOARD
  );
});

bot.command('stop', ctx => {
  const chatId = ctx.chat.id;
  const users = readJSON(USERS_FILE, { active: [] });
  users.active = users.active.filter(id => id !== chatId);
  writeJSON(USERS_FILE, users);
  log('INFO', `User ${ctx.from.id} deactivated the bot`);

  return ctx.replyWithMarkdownV2(
    '😴 *Бот зупинено\\.* Нагадування більше не надходитимуть\\.\n\nДля активації знову — /start',
    Markup.removeKeyboard()
  );
});

bot.command('list', ctx => sendList(ctx));

// ─── Button handlers ──────────────────────────────────────────────────────────

bot.hears('➕ Додати', ctx => {
  userStates[ctx.chat.id] = 'awaiting_todo';
  return ctx.replyWithMarkdownV2('✏️ *Введи текст завдання:*', Markup.forceReply());
});

bot.hears('🗑 Видалити', ctx => {
  const chatId = ctx.chat.id;
  const todos = readJSON(TODOS_FILE, []);
  if (!todos.length) {
    return ctx.reply('📭 Список порожній, нема що видаляти!', MAIN_KEYBOARD);
  }
  selections[chatId] = new Set();
  return ctx.replyWithMarkdownV2(
    '🗑 *Обери завдання для видалення:*',
    deleteKeyboard(todos, selections[chatId])
  );
});

bot.hears('📋 Список', ctx => sendList(ctx));

// ─── Message handler (for awaiting todo input) ────────────────────────────────

bot.on('text', ctx => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  if (userStates[chatId] === 'awaiting_todo') {
    const todos = readJSON(TODOS_FILE, []);
    const todo = {
      id: Date.now().toString(),
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };
    todos.push(todo);
    writeJSON(TODOS_FILE, todos);
    delete userStates[chatId];
    log('INFO', `Todo added by user ${ctx.from.id}: "${todo.text}"`);

    return ctx.replyWithMarkdownV2(
      `✅ *Додано:*\n📌 ${escMd(todo.text)}`,
      MAIN_KEYBOARD
    );
  }
});

// ─── Inline button callbacks ──────────────────────────────────────────────────

bot.action(/^t:(.+)$/, async ctx => {
  const chatId = ctx.chat.id;
  const id = ctx.match[1];

  if (!selections[chatId]) selections[chatId] = new Set();

  if (selections[chatId].has(id)) selections[chatId].delete(id);
  else selections[chatId].add(id);

  const todos = readJSON(TODOS_FILE, []);
  await ctx.editMessageReplyMarkup(deleteKeyboard(todos, selections[chatId]).reply_markup);
  return ctx.answerCbQuery();
});

bot.action('del:confirm', async ctx => {
  const chatId = ctx.chat.id;
  const selected = selections[chatId] || new Set();

  if (!selected.size) {
    return ctx.answerCbQuery('⚠️ Нічого не вибрано!');
  }

  let todos = readJSON(TODOS_FILE, []);
  const removed = todos.filter(t => selected.has(t.id));
  todos = todos.filter(t => !selected.has(t.id));
  writeJSON(TODOS_FILE, todos);
  delete selections[chatId];

  log('INFO', `User ${ctx.from.id} deleted ${removed.length} todo(s)`);

  const removedText = removed.map(t => `• ${escMd(t.text)}`).join('\n');
  await ctx.editMessageText(
    `🗑 *Видалено \\(${removed.length} шт\\.\\):*\n\n${removedText}`,
    { parse_mode: 'MarkdownV2' }
  );
  await ctx.reply('✅ Готово!', MAIN_KEYBOARD);
  return ctx.answerCbQuery();
});

bot.action('del:cancel', async ctx => {
  delete selections[ctx.chat.id];
  await ctx.editMessageText('❌ Видалення скасовано.');
  await ctx.reply('👍 Скасовано.', MAIN_KEYBOARD);
  return ctx.answerCbQuery();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendList(ctx) {
  const todos = readJSON(TODOS_FILE, []);
  return ctx.replyWithMarkdownV2(formatList(todos), MAIN_KEYBOARD);
}

// ─── Daily reminder @ 13:00 Kyiv ─────────────────────────────────────────────

cron.schedule('0 13 * * *', () => {
  const todos = readJSON(TODOS_FILE, []);
  const users = readJSON(USERS_FILE, { active: [] });

  if (!todos.length) {
    log('INFO', 'Daily reminder: list is empty, skipping');
    return;
  }

  log('INFO', `Daily reminder: sending to ${users.active.length} user(s)`);

  const message = formatDailyReminder(todos);

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
