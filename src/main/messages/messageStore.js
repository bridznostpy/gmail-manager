'use strict';
/**
 * Журнал переписки: что мы отправили и что ответил продавец.
 *
 * Зачем отдельно от dialogStore: тот решает, отвечать ли на письмо, и хранит
 * только идентификаторы да счётчик ответов. Тексты ему не нужны, а экрану
 * чатов нужны именно они.
 *
 * Запись:
 *   { id, threadId, profileId, email, dir, kind, subject, body, html, partial, ts }
 *
 *   dir     - 'out' (наше письмо) | 'in' (ответ продавца)
 *   kind    - 'first' | 'auto' | 'nudge' | 'reply'
 *   html    - разметка письма, если автоответ уходил HTML-шаблоном; в ленте чата
 *             показывается текст (body), а разметка нужна для просмотра письма
 *   partial - текст получен обрывком из списка писем, а не целиком из треда
 *
 * Файл на диске один, записи держим плоским списком: переписок немного, а
 * плоский список проще дописывать без перечитывания всего файла.
 */
const fs = require('fs');
const path = require('path');

const MAX_MESSAGES = 5000; // старее этого не храним, файл не должен пухнуть

class MessageStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.items = [];
    this._seq = 0;
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.items = Array.isArray(raw && raw.items) ? raw.items : [];
    } catch (_e) {
      this.items = [];
    }
  }

  _save() {
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * Ключ переписки. Идентификатор треда есть не всегда: первое письмо уходит
   * до того, как переписка вообще появится в Gmail. Тогда опираемся на пару
   * "почта + адрес" - она известна всегда, и позже ответ в тот же адрес
   * склеится с этим же чатом.
   *
   * Основа ключа - почта (accountKey), а не профиль: две почты одного профиля,
   * написавшие одному человеку, - это две разные переписки, и в одну их
   * склеивать нельзя.
   */
  static chatKey({ accountKey, email, threadId }) {
    const who = String(email || '').trim().toLowerCase();
    return String(accountKey || '') + '|' + (who || 't:' + String(threadId || ''));
  }

  add(entry) {
    const rec = {
      id: Date.now().toString(36) + '-' + (this._seq++).toString(36),
      chatKey: MessageStore.chatKey(entry),
      accountKey: String(entry.accountKey || ''),
      threadId: String(entry.threadId || ''),
      profileId: String(entry.profileId || ''),
      mailbox: String(entry.mailbox || ''),
      email: String(entry.email || '').trim().toLowerCase(),
      dir: entry.dir === 'in' ? 'in' : 'out',
      kind: entry.kind || 'first',
      subject: String(entry.subject == null ? '' : entry.subject),
      body: String(entry.body == null ? '' : entry.body),
      html: String(entry.html == null ? '' : entry.html),
      partial: !!entry.partial,
      ts: entry.ts || Date.now(),
      // Время переноса в архив. Ноль - переписка в работе, см. archiveProfile.
      archivedAt: 0,
    };
    this.items.push(rec);
    if (this.items.length > MAX_MESSAGES) this.items.splice(0, this.items.length - MAX_MESSAGES);
    this._save();
    return rec;
  }

  /**
   * Идентификатор треда становится известен позже, чем уходит первое письмо.
   * Дописываем его в записи этого чата, чтобы ответ и наше письмо оказались
   * в одной переписке.
   */
  attachThread({ accountKey, email, threadId }) {
    if (!threadId) return;
    const key = MessageStore.chatKey({ accountKey, email });
    let touched = false;
    for (const m of this.items) {
      if (m.chatKey === key && !m.threadId) { m.threadId = String(threadId); touched = true; }
    }
    if (touched) this._save();
  }

  /** Все записи одного чата, по возрастанию времени. */
  byChat(chatKey) {
    return this.items.filter((m) => m.chatKey === chatKey).sort((a, b) => a.ts - b.ts);
  }

  /**
   * Убрать в архив переписки удалённого профиля.
   *
   * Записи не удаляем: переписка - это то, что человек реально написал и
   * получил, и терять её вместе с профилем нельзя. В архиве она доступна на
   * чтение, а из рабочего списка уходит.
   */
  archiveProfile(profileId) {
    const id = String(profileId || '');
    if (!id) return 0;
    const now = Date.now();
    let touched = 0;
    for (const m of this.items) {
      if (m.profileId !== id || m.archivedAt) continue;
      m.archivedAt = now;
      touched++;
    }
    if (touched) this._save();
    return touched;
  }

  /** Убрать в архив всё разом. Нужно разовой миграции при обновлении. */
  archiveAll() {
    const now = Date.now();
    let touched = 0;
    for (const m of this.items) {
      if (m.archivedAt) continue;
      m.archivedAt = now;
      touched++;
    }
    if (touched) this._save();
    return touched;
  }

  /**
   * Свод по чатам: последнее сообщение, счётчики. Экрану списка не нужны
   * тела всех писем - их он запросит для открытого чата.
   */
  chats() {
    const byKey = new Map();
    for (const m of this.items) {
      const row = byKey.get(m.chatKey) || {
        chatKey: m.chatKey,
        accountKey: m.accountKey || '',
        profileId: m.profileId,
        mailbox: m.mailbox || '',
        email: m.email,
        threadId: '',
        total: 0,
        incoming: 0,
        autoReplies: 0,
        firstTs: m.ts,
        lastTs: 0,
        lastDir: '',
        lastText: '',
        // Архивной переписка считается, только когда в ней НЕТ ни одной живой
        // записи. Новый ответ продавца в старый тред возвращает её в работу -
        // отвечать на живое письмо из архива было бы странно.
        archived: true,
        archivedAt: 0,
      };
      row.total++;
      if (m.archivedAt) row.archivedAt = Math.max(row.archivedAt, m.archivedAt);
      else row.archived = false;
      if (m.dir === 'in') row.incoming++;
      // Автоответ - признак того, что переписка уже завязалась: только в такой
      // разрешена ручная отправка (см. экран чатов).
      if (m.dir === 'out' && m.kind === 'auto') row.autoReplies++;
      if (m.threadId) row.threadId = m.threadId;
      if (m.ts >= row.lastTs) {
        row.lastTs = m.ts;
        row.lastDir = m.dir;
        row.lastText = m.body || m.subject || '';
      }
      if (m.ts < row.firstTs) row.firstTs = m.ts;
      byKey.set(m.chatKey, row);
    }
    return [...byKey.values()].sort((a, b) => b.lastTs - a.lastTs);
  }
}

module.exports = { MessageStore };
