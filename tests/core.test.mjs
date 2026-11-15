import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JsonStore } from '../store.mjs';
import { venueCore } from '../core.js';
import { SEED } from '../seed.js';
import { BAR } from '../bar-data.js';

function nextBookableCafeDate() {
  const today = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const allowed = new Set([4, 5, 6, 0]);
  for (let offset = 1; offset < 15; offset += 1) {
    const iso = new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    if (allowed.has(new Date(`${iso}T12:00:00Z`).getUTCDay())) return iso;
  }
  throw new Error('Не найдена доступная дата для теста.');
}

test('JsonStore сохраняет данные между экземплярами', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mechty-store-'));
  const file = path.join(dir, 'store.json');
  try {
    const first = new JsonStore(file);
    first.set('sample', { value: 42 });
    const second = new JsonStore(file);
    assert.deepEqual(second.get('sample'), { value: 42 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('бронь через общий API сохраняется с источником Telegram и видна в админке', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mechty-core-'));
  try {
    const store = new JsonStore(path.join(dir, 'store.json'));
    const core = venueCore({ seed: SEED, store, bar: () => BAR, upload: () => '/uploads/test.webp', dataImg: false });
    const result = core.handle('POST', '/api/book', {
      zone: 'cafe', date: nextBookableCafeDate(), time: '19:00', guests: 3,
      name: 'Тест', phone: '+79990000000', comment: 'Проверка Telegram', consent: true,
      source: 'telegram', tgChatId: '123456789'
    }, false, true);
    assert.equal(result.code, 200);
    const inbox = core.handle('GET', '/api/admin/all', null, true);
    assert.equal(inbox.code, 200);
    const booking = inbox.body.inbox.book.find(item => item.id === result.body.id);
    assert.equal(booking.source, 'telegram');
    assert.equal(booking.tgChatId, '123456789');
    assert.equal(booking.st, 'new');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('без согласия бронь не создаётся', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mechty-core-'));
  try {
    const store = new JsonStore(path.join(dir, 'store.json'));
    const core = venueCore({ seed: SEED, store, bar: () => BAR, upload: () => '/uploads/test.webp', dataImg: false });
    const result = core.handle('POST', '/api/book', {
      zone: 'cafe', date: nextBookableCafeDate(), time: '19:00', guests: 3,
      name: 'Тест', phone: '+79990000000', consent: false
    }, false);
    assert.equal(result.code, 400);
    assert.match(result.body.error, /согласие/i);
    assert.equal((store.get('inbox', {}).book || []).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('публичный API не позволяет подделать Telegram chat id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mechty-core-'));
  try {
    const store = new JsonStore(path.join(dir, 'store.json'));
    const core = venueCore({ seed: SEED, store, bar: () => BAR, upload: () => '/uploads/test.webp', dataImg: false });
    const result = core.handle('POST', '/api/book', {
      zone: 'cafe', date: nextBookableCafeDate(), time: '19:00', guests: 2,
      name: 'Тест', phone: '+79990000000', consent: true,
      source: 'telegram', tgChatId: '123456789'
    }, false);
    assert.equal(result.code, 200);
    const booking = store.get('inbox').book.find(item => item.id === result.body.id);
    assert.equal(booking.source, 'site');
    assert.equal(booking.tgChatId, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
