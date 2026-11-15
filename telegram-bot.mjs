import { daysOf } from './core.js';

const UFA_OFFSET_MS = 5 * 60 * 60 * 1000;
const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const digits = value => String(value ?? '').replace(/\D/g, '');
const fmtDate = iso => {
  const date = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short', timeZone: 'UTC' }).format(date);
};
const todayUfa = () => new Date(Date.now() + UFA_OFFSET_MS).toISOString().slice(0, 10);
const minuteNowUfa = () => {
  const date = new Date(Date.now() + UFA_OFFSET_MS);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
};
const addDays = (iso, amount) => new Date(Date.parse(`${iso}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
const hm = value => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
};
const hhmm = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export function createTelegramBot({ token, adminChatIds = [], core, store, venueName = 'Мечты', siteUrl = '', bookingReady = false, logger = console }) {
  const apiRoot = token ? `https://api.telegram.org/bot${token}` : null;
  const admins = new Set(adminChatIds.map(String).filter(Boolean));
  const siteBaseUrl = (() => {
    try { const parsed = new URL(siteUrl); return parsed.protocol === 'https:' ? parsed.origin : ''; }
    catch { return ''; }
  })();
  const states = new Map();
  let offset = Math.max(0, Number(store.get('telegramOffset', 0)) || 0);
  let running = false;
  let pollPromise = null;

  async function call(method, payload = {}) {
    if (!apiRoot) throw new Error('TELEGRAM_BOT_TOKEN не задан.');
    const response = await fetch(`${apiRoot}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(35000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.description || `Telegram API ${method}: HTTP ${response.status}`);
    }
    return result.result;
  }

  async function sendMessage(chatId, text, extra = {}) {
    return call('sendMessage', { chat_id: chatId, text, ...extra });
  }

  function publicData() {
    const result = core.handle('GET', '/api/site', null, false);
    return result.body || {};
  }

  function getBooking(id) {
    const inbox = store.get('inbox', {});
    return (inbox.book || []).find(item => item.id === id) || null;
  }

  function zoneFor(id) {
    const data = publicData();
    return (data.zones || []).find(zone => zone.id === id && !zone.nobook) || null;
  }

  function availableDates(zone) {
    const allowedDays = daysOf(zone.days);
    const today = todayUfa();
    const dates = [];
    for (let i = 0; i < 70 && dates.length < 14; i += 1) {
      const iso = addDays(today, i);
      const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
      if (allowedDays.length && !allowedDays.includes(weekday)) continue;
      if (iso === today && !availableTimes(zone, iso).length) continue;
      dates.push(iso);
    }
    return dates;
  }

  function availableTimes(zone, date) {
    const from = hm(zone.from || '14:00');
    const to = hm(zone.to || '23:00');
    if (from < 0 || to < 0 || to < from) return [];
    const min = date === todayUfa() ? minuteNowUfa() + 30 : from;
    const result = [];
    for (let time = from; time <= to; time += 30) {
      if (time >= min) result.push(hhmm(time));
    }
    return result;
  }

  function mainKeyboard() {
    return { inline_keyboard: [[{ text: 'Забронировать стол', callback_data: 'bk:start' }]] };
  }

  async function showZones(chatId) {
    const zones = (publicData().zones || []).filter(zone => !zone.hidden && !zone.nobook);
    if (!zones.length) {
      await sendMessage(chatId, 'Сейчас нет доступных для бронирования зон. Позвоните нам: +7 (347) 298-13-12.');
      return;
    }
    await sendMessage(chatId, 'Выберите зал:', {
      reply_markup: { inline_keyboard: zones.map(zone => [{ text: `${zone.name}${zone.deposit ? ' · депозит' : ''}`, callback_data: `bk:zone:${zone.id}` }]) }
    });
  }

  async function showDates(chatId, zone) {
    const dates = availableDates(zone);
    if (!dates.length) {
      states.delete(String(chatId));
      await sendMessage(chatId, `Для зала «${zone.name}» пока нет доступных дат. Позвоните нам: +7 (347) 298-13-12.`, { reply_markup: mainKeyboard() });
      return;
    }
    await sendMessage(chatId, `Выберите дату для зала «${zone.name}»:`, {
      reply_markup: { inline_keyboard: chunks(dates.map(iso => ({ text: fmtDate(iso), callback_data: `bk:date:${iso}` })), 2) }
    });
  }

  async function showTimes(chatId, zone, date) {
    const times = availableTimes(zone, date);
    if (!times.length) {
      await sendMessage(chatId, 'На эту дату свободного времени для заявки уже нет. Выберите другую дату.');
      await showDates(chatId, zone);
      return;
    }
    await sendMessage(chatId, `Выберите время (${zone.from || '14:00'}–${zone.to || '23:00'}):`, {
      reply_markup: { inline_keyboard: chunks(times.map(time => ({ text: time, callback_data: `bk:time:${time}` })), 3) }
    });
  }

  async function askGuests(chatId) {
    const counts = [1, 2, 3, 4, 5, 6, 8, 10, 12];
    const buttons = counts.map(value => ({ text: String(value), callback_data: `bk:guests:${value}` }));
    buttons.push({ text: 'Другое количество', callback_data: 'bk:guests:custom' });
    await sendMessage(chatId, 'Сколько будет гостей?', { reply_markup: { inline_keyboard: chunks(buttons, 3) } });
  }

  async function askName(chatId) {
    const state = states.get(String(chatId));
    if (!state) return;
    state.step = 'name';
    await sendMessage(chatId, 'Как к вам обращаться? Напишите имя.');
  }

  async function askPhone(chatId) {
    const state = states.get(String(chatId));
    if (!state) return;
    state.step = 'phone';
    await sendMessage(chatId, 'Отправьте номер телефона кнопкой ниже или напишите его сообщением. Номер нужен, чтобы администратор мог подтвердить бронь.', {
      reply_markup: { keyboard: [[{ text: 'Отправить мой номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    });
  }

  async function askComment(chatId) {
    const state = states.get(String(chatId));
    if (!state) return;
    state.step = 'comment';
    await sendMessage(chatId, 'Комментарий к брони (необязательно): пожелания, повод или детали. Можно пропустить.', {
      reply_markup: { inline_keyboard: [[{ text: 'Пропустить', callback_data: 'bk:skip-comment' }]] }
    });
  }

  async function askConsent(chatId) {
    const state = states.get(String(chatId));
    if (!state) return;
    state.step = 'consent';
    const zone = zoneFor(state.zone);
    const summary = [
      '<b>Проверьте заявку</b>',
      `Зал: ${html(zone?.name || state.zone)}`,
      `Дата: ${html(fmtDate(state.date))}`,
      `Время: ${html(state.time)}`,
      `Гостей: ${html(state.guests)}`,
      `Имя: ${html(state.name)}`,
      `Телефон: ${html(state.phone)}`,
      state.comment ? `Комментарий: ${html(state.comment)}` : ''
    ].filter(Boolean).join('\n');
    const policyLink = siteBaseUrl ? `\n<a href="${html(siteBaseUrl)}/privacy.html">Политика конфиденциальности</a>` : '';
    await sendMessage(chatId, `${summary}\n\nНажимая «Согласен», вы подтверждаете согласие на обработку персональных данных.${policyLink}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'Согласен, отправить заявку', callback_data: 'bk:consent:yes' }, { text: 'Не согласен', callback_data: 'bk:consent:no' }]] }
    });
  }

  function bookingText(booking, source = 'сайт') {
    const data = publicData();
    const zone = (data.zones || []).find(item => item.id === booking.zone);
    return [
      `<b>Новая бронь · ${html(source)}</b>`,
      `Зал: ${html(zone?.name || booking.zone)}`,
      `Дата: ${html(fmtDate(booking.date))}`,
      `Время: ${html(booking.time)}`,
      `Гостей: ${html(booking.guests)}`,
      `Имя: ${html(booking.name)}`,
      `Телефон: ${html(booking.phone)}`,
      booking.comment ? `Комментарий: ${html(booking.comment)}` : '',
      `Заявка: <code>${html(booking.id)}</code>`
    ].filter(Boolean).join('\n');
  }

  async function notifyAdmins(booking, source = 'сайт') {
    if (!apiRoot || !admins.size) return;
    const text = bookingText(booking, source);
    const reply_markup = { inline_keyboard: [[
      { text: 'Подтвердить', callback_data: `adm:ok:${booking.id}` },
      { text: 'Отменить', callback_data: `adm:no:${booking.id}` }
    ]] };
    const results = await Promise.allSettled([...admins].map(chatId => sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup })));
    for (const result of results) if (result.status === 'rejected') logger.error('[telegram] Не удалось отправить уведомление администратору:', result.reason?.message || result.reason);
  }

  async function notifyGuest(booking, status) {
    if (!booking?.tgChatId || !apiRoot) return;
    const zone = zoneFor(booking.zone);
    const message = status === 'ok'
      ? `✅ Ваша бронь подтверждена!\n${zone?.name || booking.zone}, ${fmtDate(booking.date)} в ${booking.time}, гостей: ${booking.guests}. До встречи в «${venueName}»!`
      : `К сожалению, заявка на ${fmtDate(booking.date)} в ${booking.time} отменена. Позвоните нам: +7 (347) 298-13-12, чтобы подобрать другое время.`;
    try { await sendMessage(booking.tgChatId, message, { reply_markup: { remove_keyboard: true } }); }
    catch (error) { logger.error('[telegram] Не удалось уведомить гостя:', error.message); }
  }

  async function saveBooking(chatId) {
    const state = states.get(String(chatId));
    if (!state) return;
    const result = core.handle('POST', '/api/book', {
      zone: state.zone,
      date: state.date,
      time: state.time,
      guests: state.guests,
      name: state.name,
      phone: state.phone,
      comment: state.comment || '',
      consent: true,
      source: 'telegram',
      tgChatId: String(chatId)
    }, false, true);
    if (result.code !== 200 || result.body?.error) {
      await sendMessage(chatId, result.body?.error || 'Не удалось отправить заявку. Попробуйте ещё раз.', { reply_markup: { remove_keyboard: true } });
      states.delete(String(chatId));
      return;
    }
    const booking = getBooking(result.body.id);
    states.delete(String(chatId));
    await sendMessage(chatId, `Заявка отправлена! Администратор свяжется с вами для подтверждения.${result.body.deposit ? '\nДля этого зала действует депозит — условия уточнит администратор.' : ''}`, { reply_markup: { remove_keyboard: true } });
    if (booking) await notifyAdmins(booking, 'Telegram-бот');
  }

  async function processCallback(query) {
    const chatId = query.message?.chat?.id;
    const userId = query.from?.id;
    const data = String(query.data || '');
    try {
      if (data === 'bk:start') {
        if (!admins.size || !siteBaseUrl || !bookingReady) {
          await sendMessage(chatId, 'Бот ещё настраивается. Для бронирования пока позвоните: +7 (347) 298-13-12.');
          return;
        }
        states.set(String(chatId), { step: 'zone', chatId, userId });
        await showZones(chatId);
        return;
      }
      if (data.startsWith('bk:')) {
        const state = states.get(String(chatId));
        if (!state) {
          await sendMessage(chatId, 'Сессия бронирования закончилась. Нажмите /start, чтобы начать заново.');
          return;
        }
        if (data.startsWith('bk:zone:')) {
          const zoneId = data.slice('bk:zone:'.length);
          const zone = zoneFor(zoneId);
          if (!zone) { await sendMessage(chatId, 'Эта зона больше недоступна для бронирования. Начните заново: /start'); return; }
          state.zone = zoneId;
          state.step = 'date';
          await showDates(chatId, zone);
          return;
        }
        if (data.startsWith('bk:date:')) {
          const iso = data.slice('bk:date:'.length);
          const zone = zoneFor(state.zone);
          if (!zone || !availableDates(zone).includes(iso)) { await sendMessage(chatId, 'Эта дата недоступна. Выберите другую.'); if (zone) await showDates(chatId, zone); return; }
          state.date = iso;
          state.step = 'time';
          await showTimes(chatId, zone, iso);
          return;
        }
        if (data.startsWith('bk:time:')) {
          const time = data.slice('bk:time:'.length);
          const zone = zoneFor(state.zone);
          if (!zone || !availableTimes(zone, state.date).includes(time)) { await sendMessage(chatId, 'Это время уже недоступно. Выберите другое.'); if (zone) await showTimes(chatId, zone, state.date); return; }
          state.time = time;
          state.step = 'guests';
          await askGuests(chatId);
          return;
        }
        if (data.startsWith('bk:guests:')) {
          const count = data.slice('bk:guests:'.length);
          if (count === 'custom') { state.step = 'guests_custom'; await sendMessage(chatId, 'Напишите количество гостей числом (от 1 до 300).'); return; }
          const guests = Number(count);
          if (!Number.isInteger(guests) || guests < 1 || guests > 300) { await sendMessage(chatId, 'Укажите от 1 до 300 гостей.'); return; }
          state.guests = guests;
          await askName(chatId);
          return;
        }
        if (data === 'bk:skip-comment') { state.comment = ''; await askConsent(chatId); return; }
        if (data === 'bk:consent:no') {
          states.delete(String(chatId));
          await sendMessage(chatId, 'Заявка не отправлена. Чтобы начать заново, нажмите /start.', { reply_markup: { remove_keyboard: true } });
          return;
        }
        if (data === 'bk:consent:yes') {
          if (state.step !== 'consent') return;
          await saveBooking(chatId);
          return;
        }
      }
      if (data.startsWith('adm:')) {
        if (!admins.has(String(chatId))) {
          await sendMessage(chatId, 'Нет доступа к управлению бронями.');
          return;
        }
        const [, status, id] = data.split(':');
        if (!['ok', 'no'].includes(status) || !id) return;
        const currentBooking = getBooking(id);
        if (!currentBooking) { await sendMessage(chatId, 'Заявка уже не найдена.'); return; }
        if (currentBooking.st !== 'new') { await sendMessage(chatId, 'Статус этой брони уже изменён.'); return; }
        const result = core.handle('POST', '/api/admin/status', { box: 'book', id, st: status }, true);
        if (result.code !== 200 || result.body?.error) {
          await sendMessage(chatId, result.body?.error || 'Не удалось изменить статус.');
          return;
        }
        const booking = getBooking(id);
        if (booking) await notifyGuest(booking, status);
        await call('editMessageText', {
          chat_id: chatId,
          message_id: query.message.message_id,
          text: booking ? `${bookingText(booking, 'статус обновлён')}\n\n<b>${status === 'ok' ? '✅ Бронь подтверждена' : '❌ Бронь отменена'}</b>` : `<b>Заявка ${html(id)} обновлена.</b>`,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        });
      }
    } finally {
      try { await call('answerCallbackQuery', { callback_query_id: query.id }); } catch {}
    }
  }

  async function processMessage(message) {
    if (!message?.chat?.id || message.chat.type !== 'private') return;
    const chatId = message.chat.id;
    const key = String(chatId);
    const text = String(message.text || '').trim();

    if (text === '/id') {
      await sendMessage(chatId, `chat_id: ${chatId}\nuser_id: ${message.from?.id || 'неизвестен'}\nДобавьте chat_id в TELEGRAM_ADMIN_CHAT_IDS на сервере, чтобы получать заявки.`);
      return;
    }
    if (text === '/start' || text.startsWith('/start ')) {
      states.delete(key);
      await sendMessage(chatId, `Здравствуйте! Это бот бронирования «${venueName}». Здесь можно оставить заявку на стол.`, { reply_markup: mainKeyboard() });
      return;
    }
    if (text === '/cancel') {
      states.delete(key);
      await sendMessage(chatId, 'Бронирование отменено. Чтобы начать заново, нажмите /start.', { reply_markup: { remove_keyboard: true } });
      return;
    }

    const state = states.get(key);
    if (!state) {
      await sendMessage(chatId, 'Чтобы забронировать стол, нажмите кнопку ниже.', { reply_markup: mainKeyboard() });
      return;
    }
    if (state.step === 'guests_custom') {
      const guests = Number(text);
      if (!Number.isInteger(guests) || guests < 1 || guests > 300) { await sendMessage(chatId, 'Введите целое число от 1 до 300.'); return; }
      state.guests = guests;
      await askName(chatId);
      return;
    }
    if (state.step === 'name') {
      const name = text.slice(0, 80);
      if (!name || name.startsWith('/')) { await sendMessage(chatId, 'Напишите, пожалуйста, ваше имя.'); return; }
      state.name = name;
      await askPhone(chatId);
      return;
    }
    if (state.step === 'phone') {
      let phone = '';
      if (message.contact && (!message.contact.user_id || message.contact.user_id === message.from?.id)) phone = message.contact.phone_number || '';
      else phone = text;
      if (digits(phone).length < 10) { await sendMessage(chatId, 'Не получилось распознать номер. Отправьте контакт кнопкой или введите телефон ещё раз.'); return; }
      state.phone = phone.startsWith('+') ? phone : `+${digits(phone)}`;
      await askComment(chatId);
      return;
    }
    if (state.step === 'comment') {
      state.comment = text.slice(0, 500);
      await askConsent(chatId);
    }
  }

  async function processUpdate(update) {
    if (update.callback_query) await processCallback(update.callback_query);
    else if (update.message) await processMessage(update.message);
  }

  async function pollLoop() {
    if (!apiRoot) return;
    try { await call('deleteWebhook', { drop_pending_updates: false }); }
    catch (error) { logger.error('[telegram] Не удалось подготовить long polling:', error.message); }
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates || []) {
          if (update.update_id < offset) continue;
          try { await processUpdate(update); }
          catch (error) { logger.error('[telegram] Ошибка обработки обновления:', error.message); }
          offset = Math.max(offset, update.update_id + 1);
          store.set('telegramOffset', offset);
        }
      } catch (error) {
        if (running) {
          logger.error('[telegram] Ошибка получения обновлений:', error.message);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }
  }

  function start() {
    if (!apiRoot) {
      logger.warn('[telegram] Бот не запущен: задайте TELEGRAM_BOT_TOKEN.');
      return;
    }
    if (!admins.size) logger.warn('[telegram] TELEGRAM_ADMIN_CHAT_IDS не задан: заявки не будут отправляться администраторам. Используйте /id в личном чате с ботом.');
    if (running) return;
    running = true;
    pollPromise = pollLoop();
  }

  async function stop() {
    running = false;
    if (pollPromise) await Promise.race([pollPromise, new Promise(resolve => setTimeout(resolve, 1000))]);
  }

  return { start, stop, notifyAdmins, notifyGuest, enabled: Boolean(apiRoot), adminChatIds: [...admins] };
}
