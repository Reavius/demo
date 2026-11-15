import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JsonStore } from '../store.mjs';
import { venueCore } from '../core.js';
import { SEED } from '../seed.js';
import { BAR } from '../bar-data.js';
import { createTelegramBot } from '../telegram-bot.mjs';

const waitFor = async (condition, label) => {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout waiting for ${label}`);
};

test('Telegram wizard creates a shared booking and admin callback confirms it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mechty-telegram-'));
  const originalFetch = globalThis.fetch;
  const updates = [];
  const sent = [];
  let deletedWebhook = false;
  let messageId = 1000;
  let bot = null;

  globalThis.fetch = async (url, options = {}) => {
    const method = new URL(url).pathname.split('/').pop();
    const payload = JSON.parse(options.body || '{}');
    let result = true;
    if (method === 'deleteWebhook') deletedWebhook = true;
    if (method === 'getUpdates') {
      await new Promise(resolve => setTimeout(resolve, 8));
      result = updates.splice(0, updates.length);
    }
    if (method === 'sendMessage') {
      sent.push(payload);
      result = { message_id: ++messageId, chat: { id: payload.chat_id } };
    }
    if (method === 'editMessageText' || method === 'answerCallbackQuery') result = true;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };

  const pushMessage = (id, text, extra = {}) => updates.push({
    update_id: id,
    message: { message_id: id + 100, chat: { id: 555, type: 'private' }, from: { id: 555 }, text, ...extra }
  });
  const pushCallback = (id, data, chatId = 555, fromId = 555) => updates.push({
    update_id: id,
    callback_query: {
      id: `q${id}`, from: { id: fromId },
      message: { message_id: id + 100, chat: { id: chatId, type: 'private' } }, data
    }
  });

  try {
    const store = new JsonStore(path.join(dir, 'store.json'));
    const core = venueCore({ seed: SEED, store, bar: () => BAR, dataImg: false, upload: () => '/uploads/test.webp' });
    bot = createTelegramBot({ token: 'TEST_TOKEN', adminChatIds: ['999'], core, store, siteUrl: 'https://mechty.example', bookingReady: true, logger: { warn() {}, error() {} } });
    bot.start();
    await waitFor(() => deletedWebhook, 'bot polling start');

    pushMessage(1, '/start');
    await waitFor(() => sent.some(item => item.text.includes('Это бот бронирования')), 'welcome message');
    pushCallback(2, 'bk:start');
    await waitFor(() => sent.some(item => item.text === 'Выберите зал:'), 'zone choices');
    pushCallback(3, 'bk:zone:cafe');
    await waitFor(() => sent.some(item => item.text.startsWith('Выберите дату')), 'date choices');
    const dateMessage = [...sent].reverse().find(item => item.text.startsWith('Выберите дату'));
    const dateData = dateMessage.reply_markup.inline_keyboard[0][0].callback_data;
    pushCallback(4, dateData);
    await waitFor(() => sent.some(item => item.text.startsWith('Выберите время')), 'time choices');
    const timeMessage = [...sent].reverse().find(item => item.text.startsWith('Выберите время'));
    const timeData = timeMessage.reply_markup.inline_keyboard[0][0].callback_data;
    pushCallback(5, timeData);
    await waitFor(() => sent.some(item => item.text === 'Сколько будет гостей?'), 'guest choices');
    pushCallback(6, 'bk:guests:2');
    await waitFor(() => sent.some(item => item.text.includes('Как к вам обращаться')), 'name prompt');
    pushMessage(7, 'Алексей');
    await waitFor(() => sent.some(item => item.text.includes('Отправьте номер телефона')), 'phone prompt');
    pushMessage(8, '', { contact: { phone_number: '+79990000000', user_id: 555 } });
    await waitFor(() => sent.some(item => item.text.includes('Комментарий к брони')), 'comment prompt');
    pushCallback(9, 'bk:skip-comment');
    await waitFor(() => sent.some(item => item.text.includes('Проверьте заявку')), 'consent prompt');
    pushCallback(10, 'bk:consent:yes');
    await waitFor(() => sent.some(item => item.text.includes('Заявка отправлена')), 'guest booking receipt');
    await waitFor(() => sent.some(item => String(item.chat_id) === '999' && item.text.includes('Новая бронь')), 'admin notification');

    const booking = store.get('inbox').book[0];
    assert.equal(booking.source, 'telegram');
    assert.equal(booking.tgChatId, '555');
    assert.equal(booking.st, 'new');

    pushCallback(11, `adm:ok:${booking.id}`, 999, 999);
    await waitFor(() => store.get('inbox').book[0].st === 'ok', 'admin confirmation');
    await waitFor(() => sent.some(item => String(item.chat_id) === '555' && item.text.includes('Ваша бронь подтверждена')), 'guest confirmation');
  } finally {
    await bot?.stop();
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
