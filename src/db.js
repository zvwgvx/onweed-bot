// SQLite access layer. Uses the built-in node:sqlite module (no native dependencies).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dbFile = path.resolve(config.dbPath);
mkdirSync(path.dirname(dbFile), { recursive: true });

export const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  case_number   INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  moderator_id  TEXT NOT NULL,
  type          TEXT NOT NULL,
  reason        TEXT,
  duration_ms   INTEGER,
  expires_at    INTEGER,
  status        TEXT NOT NULL DEFAULT 'active',
  hidden        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER,
  UNIQUE (guild_id, case_number)
);

CREATE INDEX IF NOT EXISTS idx_cases_user   ON cases (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (guild_id, status, type);
CREATE INDEX IF NOT EXISTS idx_cases_temp   ON cases (status, expires_at);

CREATE TABLE IF NOT EXISTS trap_stats (
  guild_id TEXT NOT NULL,
  key      TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE IF NOT EXISTS install_messages (
  guild_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'general',
  status      TEXT NOT NULL DEFAULT 'open',
  closed_by   TEXT,
  closed_note TEXT,
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tickets_guild  ON tickets (guild_id, status, owner_id);
CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets (channel_id);

CREATE TABLE IF NOT EXISTS voice_channels (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  owner_id         TEXT NOT NULL,
  number           INTEGER NOT NULL DEFAULT 0,
  panel_message_id TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_guild   ON voice_channels (guild_id, owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_channel ON voice_channels (channel_id);
`);

// Legacy databases: add the number column when the table already exists without it
// (the statement fails silently when the fresh schema above created it).
try {
  db.exec('ALTER TABLE voice_channels ADD COLUMN number INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists.
}

// Legacy databases: add the ticket type column (existing rows count as general tickets).
try {
  db.exec("ALTER TABLE tickets ADD COLUMN type TEXT NOT NULL DEFAULT 'general'");
} catch {
  // Column already exists.
}

// Migration from the initial schema (active flag -> status).
const columns = db.prepare('PRAGMA table_info(cases)').all().map((c) => c.name);
if (!columns.includes('status')) {
  db.exec("ALTER TABLE cases ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  db.exec("UPDATE cases SET status = CASE WHEN active = 1 THEN 'active' ELSE 'removed' END");
}
// The old per-guild config table is superseded by config.json.
db.exec('DROP TABLE IF EXISTS guild_config');

// Older installs tracked only the trap message; migrate it into install_messages.
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
if (tables.includes('trap_message')) {
  db.exec(
    `INSERT OR REPLACE INTO install_messages (guild_id, key, channel_id, message_id)
     SELECT guild_id, 'trap', channel_id, message_id FROM trap_message`,
  );
  db.exec('DROP TABLE trap_message');
}

// ---------- Cases ----------

export function createCase({
  guildId,
  userId,
  moderatorId,
  type,
  reason = null,
  durationMs = null,
  createdAt = Date.now(),
}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const { n } = db
      .prepare('SELECT COALESCE(MAX(case_number), 0) + 1 AS n FROM cases WHERE guild_id = ?')
      .get(guildId);

    const expiresAt = durationMs ? createdAt + durationMs : null;
    const info = db
      .prepare(
        `INSERT INTO cases
          (guild_id, case_number, user_id, moderator_id, type, reason, duration_ms, expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(guildId, n, userId, moderatorId, type, reason, durationMs, expiresAt, createdAt, createdAt);

    db.exec('COMMIT');
    return getCaseById(Number(info.lastInsertRowid));
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const getCaseById = (id) => db.prepare('SELECT * FROM cases WHERE id = ?').get(id) ?? null;

export const getCaseByNumber = (guildId, caseNumber) =>
  db.prepare('SELECT * FROM cases WHERE guild_id = ? AND case_number = ?').get(guildId, caseNumber) ??
  null;

export function listCases({ guildId, userId = null, type = null, limit = 5, offset = 0 }) {
  const where = ['guild_id = ?', 'hidden = 0'];
  const params = [guildId];
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (type && type !== 'all') {
    where.push('type = ?');
    params.push(type);
  }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM cases WHERE ${whereSql} ORDER BY case_number DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { rows, total };
}

export const countActiveByType = (guildId, userId, type) =>
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM cases WHERE guild_id = ? AND user_id = ? AND type = ? AND status = 'active' AND hidden = 0",
    )
    .get(guildId, userId, type).n;

export function getActiveCases(guildId, userId, type = null) {
  const base =
    "SELECT * FROM cases WHERE guild_id = ? AND user_id = ? AND status = 'active' AND hidden = 0";
  return type
    ? db.prepare(`${base} AND type = ? ORDER BY id DESC`).all(guildId, userId, type)
    : db.prepare(`${base} ORDER BY id DESC`).all(guildId, userId);
}

export const getActiveTempCases = () =>
  db
    .prepare(
      "SELECT * FROM cases WHERE status = 'active' AND hidden = 0 AND expires_at IS NOT NULL AND type IN ('mute', 'ban')",
    )
    .all();

// Mark a single case as expired (timer elapsed) or removed (manually undone / cleared).
export const setCaseStatus = (id, status) =>
  Number(
    db.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
      .changes,
  );

export const setActiveCasesStatus = (guildId, userId, type, status) =>
  Number(
    db
      .prepare(
        "UPDATE cases SET status = ?, updated_at = ? WHERE guild_id = ? AND user_id = ? AND type = ? AND status = 'active'",
      )
      .run(status, Date.now(), guildId, userId, type).changes,
  );

export const hideCase = (id) =>
  Number(db.prepare('UPDATE cases SET hidden = 1, updated_at = ? WHERE id = ?').run(Date.now(), id).changes);

// ---------- Do-not-type trap ----------

export function bumpTrapStat(guildId, key) {
  db.prepare(
    `INSERT INTO trap_stats (guild_id, key, count) VALUES (?, ?, 1)
     ON CONFLICT (guild_id, key) DO UPDATE SET count = count + 1`,
  ).run(guildId, key);
}

export const getTrapStats = (guildId) => {
  const rows = db.prepare('SELECT key, count FROM trap_stats WHERE guild_id = ?').all(guildId);
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.count)]));
};

// ---------- Install messages (setup embeds the bot keeps in channels) ----------

export const getInstallMessage = (guildId, key) =>
  db.prepare('SELECT * FROM install_messages WHERE guild_id = ? AND key = ?').get(guildId, key) ?? null;

export const listInstallMessages = (guildId) =>
  db.prepare('SELECT * FROM install_messages WHERE guild_id = ?').all(guildId);

export function setInstallMessage(guildId, key, channelId, messageId) {
  db.prepare(
    `INSERT INTO install_messages (guild_id, key, channel_id, message_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, key) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id`,
  ).run(guildId, key, channelId, messageId);
}

export const deleteInstallMessage = (guildId, key) =>
  Number(db.prepare('DELETE FROM install_messages WHERE guild_id = ? AND key = ?').run(guildId, key).changes);

// ---------- Tickets ----------

export function createTicketRow({ guildId, channelId, ownerId, type = 'general', createdAt = Date.now() }) {
  const info = db
    .prepare(
      'INSERT INTO tickets (guild_id, channel_id, owner_id, type, status, created_at) VALUES (?, ?, ?, ?, \'open\', ?)',
    )
    .run(guildId, channelId, ownerId, type, createdAt);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(info.lastInsertRowid));
}

export const getOpenTicketByOwner = (guildId, userId, type = null) =>
  db
    .prepare(
      `SELECT * FROM tickets
       WHERE guild_id = ? AND owner_id = ? AND status = 'open'${type ? ' AND type = ?' : ''}
       ORDER BY id DESC`,
    )
    .all(...(type ? [guildId, userId, type] : [guildId, userId]))[0] ?? null;

export const getTicketByChannel = (guildId, channelId) =>
  db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId) ?? null;

export function closeTicketRow(id, { closedBy, note = null }) {
  db.prepare(
    "UPDATE tickets SET status = 'closed', closed_by = ?, closed_note = ?, closed_at = ? WHERE id = ?",
  ).run(closedBy, note, Date.now(), id);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) ?? null;
}

// Channel ids of every tracked ticket (checked when lifting the verification gate,
// since ticket channels manage their own @everyone lock).
export const listTicketChannelIds = (guildId) =>
  db.prepare('SELECT channel_id FROM tickets WHERE guild_id = ?').all(guildId).map((r) => r.channel_id);

// ---------- Dynamic voice channels (create-voice) ----------

export function createVoiceRow({ guildId, channelId, ownerId, number = 0, createdAt = Date.now() }) {
  db.prepare(
    'INSERT INTO voice_channels (guild_id, channel_id, owner_id, number, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(guildId, channelId, ownerId, number, createdAt);
  return db.prepare('SELECT * FROM voice_channels WHERE channel_id = ?').get(channelId);
}

export const getNextVoiceNumber = (guildId) =>
  Number(
    db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM voice_channels WHERE guild_id = ?').get(guildId)?.next,
  );

export const getVoiceRowByChannel = (guildId, channelId) =>
  db.prepare('SELECT * FROM voice_channels WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId) ?? null;

export const getVoiceRowByOwner = (guildId, userId) =>
  db.prepare('SELECT * FROM voice_channels WHERE guild_id = ? AND owner_id = ? ORDER BY id DESC').get(guildId, userId) ?? null;

export const setVoicePanelMessage = (id, messageId) =>
  db.prepare('UPDATE voice_channels SET panel_message_id = ? WHERE id = ?').run(messageId, id);

export const deleteVoiceRow = (guildId, channelId) =>
  Number(
    db.prepare('DELETE FROM voice_channels WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId).changes,
  );

export const setVoiceOwner = (guildId, channelId, ownerId) =>
  db
    .prepare('UPDATE voice_channels SET owner_id = ? WHERE guild_id = ? AND channel_id = ?')
    .run(ownerId, guildId, channelId);

// Channel ids of every spawned voice room (checked when lifting the verification
// gate, since private rooms manage their own @everyone lock).
export const listVoiceChannelIds = (guildId) =>
  db.prepare('SELECT channel_id FROM voice_channels WHERE guild_id = ?').all(guildId).map((r) => r.channel_id);
