'use strict';
/**
 * Состояние переписок автоответчика. Своё, а не подсмотренное у Gmail.
 *
 * Раньше признак "сюда надо ответить" брался из прочитанности письма. Это чужое
 * состояние: список писем умеет отставать, а пометка прочитанности зависит от
 * того, открыли ли переписку. Оба раза, когда автоответ сбоил, виновата была
 * именно она. Теперь ведём учёт сами и переживаем перезапуск приложения.
 *
 * Ключ - ПОЧТА плюс переписка (см. mailbox.accountKey): один и тот же тред у
 * разных почт это разные диалоги, а почт в одном профиле бывает несколько.
 *
 * Новизну определяем по идентификатору последнего письма треда - Gmail держит
 * его в строке списка (data-legacy-last-message-id). Все идентификаторы,
 * которые мы уже разобрали, лежат в `seenMessageIds`, включая наш собственный
 * ответ: иначе он сам выглядел бы новым письмом продавца.
 *
 * Прочитать идентификатор своего ответа удаётся не всегда (строка списка
 * обновляется не мгновенно). На этот случай есть `pendingOwn`: первое
 * изменение после нашего ответа - это наш ответ, его просто запоминаем и не
 * считаем поводом отвечать снова.
 */
const fs = require('fs');
const path = require('path');

// Больше и не нужно: нас интересуют последние письма треда, а не вся история.
const MAX_SEEN = 8;

class DialogStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.byKey = new Map();
    this._load();
  }

  _load() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(arr)) {
        for (const d of arr) {
          if (!d || !d.key) continue;
          if (!Array.isArray(d.seenMessageIds)) d.seenMessageIds = [];
          this.byKey.set(d.key, d);
        }
      }
    } catch (_e) { /* первый запуск или файл нечитаем - пустой список */ }
  }

  _save() {
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify([...this.byKey.values()], null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  _key(accountKey, threadId) {
    return String(accountKey || '') + ':' + String(threadId || '');
  }

  get(accountKey, threadId) {
    return this.byKey.get(this._key(accountKey, threadId)) || null;
  }

  list() {
    return [...this.byKey.values()];
  }

  /**
   * Что делать с перепиской:
   *
   * - `new`     - её ещё не видели, это первый ответ продавца;
   * - `reply`   - продавец написал снова, последнее письмо изменилось;
   * - `own`     - изменение принесли мы сами своим прошлым ответом;
   * - `same`    - с прошлого раза ничего не изменилось;
   * - `limit`   - лимит ответов на диалог исчерпан.
   */
  decide(accountKey, threadId, lastMessageId, maxReplies) {
    const rec = this.get(accountKey, threadId);
    if (!rec) return 'new';
    if (rec.replies >= maxReplies) return 'limit';
    // Идентификатора в разметке строки может не быть. Судить о новизне тогда
    // нечем, и отвечать повторно нельзя - иначе вернёмся к веерным дублям.
    if (!lastMessageId) return 'same';
    if (rec.seenMessageIds.indexOf(lastMessageId) >= 0) return 'same';
    if (rec.pendingOwn) return 'own';
    return 'reply';
  }

  _push(rec, messageId) {
    if (!messageId || rec.seenMessageIds.indexOf(messageId) >= 0) return;
    rec.seenMessageIds.push(messageId);
    if (rec.seenMessageIds.length > MAX_SEEN) rec.seenMessageIds.shift();
  }

  /**
   * Записать отправленный автоответ.
   *
   * `seenMessageId` - письмо продавца, на которое ответили. `ownMessageId` -
   * наш ответ, если его удалось разглядеть в строке списка; не удалось -
   * взводим pendingOwn и опознаем его при следующем проходе.
   */
  recordReply(accountKey, threadId, {
    profileId = '', mailbox = '', email = '', seenMessageId = '', ownMessageId = '',
  } = {}) {
    const key = this._key(accountKey, threadId);
    const rec = this.byKey.get(key) || {
      key,
      accountKey: String(accountKey || ''),
      // Профиль и почту держим отдельными полями: экраны группируют переписки по
      // профилю, а из составного ключа его пришлось бы разбирать строкой.
      profileId: String(profileId || ''),
      mailbox: String(mailbox || ''),
      threadId: String(threadId || ''),
      email: '',
      replies: 0,
      seenMessageIds: [],
      pendingOwn: false,
      firstReplyAt: Date.now(),
    };
    rec.email = email || rec.email;
    rec.replies += 1;
    rec.lastReplyAt = Date.now();
    this._push(rec, seenMessageId);
    if (ownMessageId) {
      this._push(rec, ownMessageId);
      rec.pendingOwn = false;
    } else {
      rec.pendingOwn = true;
    }
    this.byKey.set(key, rec);
    this._save();
    return rec;
  }

  /**
   * Запомнить письмо, не считая это ответом: мы его разобрали и отвечать не
   * стали (лимит, или это наш же ответ). Иначе перебирали бы его каждый проход.
   */
  noteSeen(accountKey, threadId, lastMessageId) {
    const rec = this.get(accountKey, threadId);
    if (!rec || !lastMessageId) return rec;
    if (rec.seenMessageIds.indexOf(lastMessageId) >= 0 && !rec.pendingOwn) return rec;
    this._push(rec, lastMessageId);
    rec.pendingOwn = false;
    this._save();
    return rec;
  }
}

module.exports = { DialogStore };
