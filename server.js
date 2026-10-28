import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const COOKIE_NAME = 'attendance_session';
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
const QR_WINDOW_SECONDS = 10;
const QR_SECRET = process.env.QR_SECRET || randomBytes(32).toString('hex');
const sessions = new Map();
const usePostgres = Boolean(process.env.DATABASE_URL);
const sqliteDatabase = usePostgres ? null : new DatabaseSync(process.env.SQLITE_PATH || join(ROOT, 'attendance.db'));
const postgresPool = usePostgres ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;

const SQLITE_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('instructor', 'student', 'admin')),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
    recovery_email TEXT,
    recovery_email_verified_at TEXT
  );
  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    instructor_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS enrollments (
    course_id INTEGER NOT NULL REFERENCES courses(id),
    student_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (course_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    year_count INTEGER NOT NULL DEFAULT 3 CHECK (year_count BETWEEN 1 AND 6)
  );
  CREATE TABLE IF NOT EXISTS student_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    department_id INTEGER NOT NULL REFERENCES departments(id),
    year_number INTEGER NOT NULL CHECK (year_number BETWEEN 1 AND 6),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS class_sessions (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id),
    instructor_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    instructor_name_snapshot TEXT
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES class_sessions(id),
    student_id INTEGER NOT NULL REFERENCES users(id),
    method TEXT NOT NULL CHECK (method IN ('qr', 'manual')),
    marked_at TEXT NOT NULL,
    UNIQUE (session_id, student_id)
  );
  CREATE INDEX IF NOT EXISTS attendance_session_idx ON attendance(session_id);
  CREATE TABLE IF NOT EXISTS recovery_email_tokens (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_reset_requests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES password_reset_requests(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS password_reset_requests_status_idx ON password_reset_requests(status, requested_at);
  CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id);
`;

const POSTGRES_SCHEMA = readFileSync(join(ROOT, 'schema.postgres.sql'), 'utf8');

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function databaseContext(client = null) {
  return {
    exec: async sql => {
      if (usePostgres) await (client || postgresPool).query(sql);
      else sqliteDatabase.exec(sql);
    },
    prepare: sql => ({
      get: async (...params) => {
        if (!usePostgres) return sqliteDatabase.prepare(sql).get(...params);
        const result = await (client || postgresPool).query(postgresSql(sql), params);
        return result.rows[0];
      },
      all: async (...params) => {
        if (!usePostgres) return sqliteDatabase.prepare(sql).all(...params);
        const result = await (client || postgresPool).query(postgresSql(sql), params);
        return result.rows;
      },
      run: async (...params) => {
        if (!usePostgres) return sqliteDatabase.prepare(sql).run(...params);
        const result = await (client || postgresPool).query(postgresSql(sql), params);
        return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
      },
    }),
    transaction: async callback => {
      if (!usePostgres) {
        sqliteDatabase.exec('BEGIN IMMEDIATE');
        try {
          const result = await callback(databaseContext());
          sqliteDatabase.exec('COMMIT');
          return result;
        } catch (error) {
          sqliteDatabase.exec('ROLLBACK');
          throw error;
        }
      }
      const client = await postgresPool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(databaseContext(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: async () => {
      if (usePostgres) await postgresPool.end();
      else sqliteDatabase.close();
    },
  };
}

const database = databaseContext();

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = stored.split(':');
  const expected = Buffer.from(expectedHex || '', 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashOpaqueToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function appBaseUrl() {
  const configured = String(process.env.APP_BASE_URL || '').trim();
  if (configured) {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' && !(parsed.hostname === 'localhost' && parsed.protocol === 'http:')) throw new Error('APP_BASE_URL must use HTTPS (or localhost for development).');
    return parsed.origin;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Set APP_BASE_URL to the public HTTPS app URL before using email recovery.');
  return `http://localhost:${PORT}`;
}

async function sendEmail({ to, subject, text, html }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const fromEmail = validEmail(process.env.MAIL_FROM_EMAIL);
  if (!apiKey || !fromEmail) throw new Error('Email recovery is not configured. Set RESEND_API_KEY and a verified MAIL_FROM_EMAIL.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: `${String(process.env.MAIL_FROM_NAME || 'DIST Attendance').replace(/[<>\r\n]/g, '').slice(0, 80)} <${fromEmail}>`,
      to: [to], subject, text, html,
    }),
  });
  if (!response.ok) throw new Error(`Email delivery failed (${response.status}).`);
}

function invalidateUserSessions(userId) {
  for (const [token, session] of sessions) if (Number(session.userId) === Number(userId)) sessions.delete(token);
}

function opaqueToken() {
  return randomBytes(32).toString('base64url');
}

function tokenExpiry(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function beginRecoveryEmailVerification(userId, email) {
  const token = opaqueToken();
  const tokenHash = hashOpaqueToken(token);
  const expiresAt = tokenExpiry(24 * 60);
  await database.transaction(async tx => {
    await tx.prepare('DELETE FROM recovery_email_tokens WHERE user_id = ?').run(userId);
    await tx.prepare('INSERT INTO recovery_email_tokens (user_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .run(userId, email, tokenHash, expiresAt);
  });
  try {
    const link = `${appBaseUrl()}/#verify-email=${token}`;
    await sendEmail({
      to: email,
      subject: 'Verify your DIST Attendance recovery email',
      text: `Use this link to verify your DIST Attendance recovery email. It expires in 24 hours and can be used once:\n\n${link}\n\nIf you did not request this, you can ignore this message.`,
    });
  } catch (error) {
    await database.prepare('DELETE FROM recovery_email_tokens WHERE user_id = ? AND token_hash = ?').run(userId, tokenHash);
    throw error;
  }
}

function recoveryEmailVerified(user) {
  return Boolean(user?.recovery_email && user?.recovery_email_verified_at);
}

function migrateLocalUsersForAdminRole() {
  const schema = sqliteDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
  const columns = sqliteDatabase.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!schema.includes("'admin'")) {
    sqliteDatabase.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE users_migrated (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('instructor', 'student', 'admin')),
        must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))
      );
      INSERT INTO users_migrated (id, name, username, password_hash, role) SELECT id, name, username, password_hash, role FROM users;
      DROP TABLE users;
      ALTER TABLE users_migrated RENAME TO users;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } else if (!columns.includes('must_change_password')) {
    sqliteDatabase.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))');
  }
}

function migrateLocalUserActiveFlag() {
  const columns = sqliteDatabase.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!columns.includes('is_active')) {
    sqliteDatabase.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))');
  }
}

function migrateLocalUserArchiveFlag() {
  const columns = sqliteDatabase.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!columns.includes('is_archived')) {
    sqliteDatabase.exec('ALTER TABLE users ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1))');
  }
}

function migrateLocalRecoveryEmailColumns() {
  const columns = sqliteDatabase.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!columns.includes('recovery_email')) sqliteDatabase.exec('ALTER TABLE users ADD COLUMN recovery_email TEXT');
  if (!columns.includes('recovery_email_verified_at')) sqliteDatabase.exec('ALTER TABLE users ADD COLUMN recovery_email_verified_at TEXT');
}

function migrateLocalSessionInstructorSnapshot() {
  const columns = sqliteDatabase.prepare('PRAGMA table_info(class_sessions)').all().map(column => column.name);
  if (!columns.includes('instructor_name_snapshot')) {
    sqliteDatabase.exec('ALTER TABLE class_sessions ADD COLUMN instructor_name_snapshot TEXT');
    sqliteDatabase.exec(`UPDATE class_sessions SET instructor_name_snapshot = (
      SELECT name FROM users WHERE users.id = class_sessions.instructor_id
    ) WHERE instructor_name_snapshot IS NULL`);
  }
}

async function seedLocalDemoDatabase() {
  const existing = Number((await database.prepare('SELECT COUNT(*) AS count FROM users').get()).count);
  if (existing) return;
  await database.transaction(async tx => {
    const addUser = tx.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)');
    const instructorId = Number((await addUser.run('Jordan Lee', 'instructor', hashPassword('teach123'), 'instructor')).lastInsertRowid);
    const studentNames = ['Aarav Patel', 'Ananya Sharma', 'Diya Nair', 'Ishaan Gupta', 'Kabir Mehta', 'Meera Iyer'];
    const studentIds = [];
    for (let index = 0; index < studentNames.length; index += 1) {
      studentIds.push(Number((await addUser.run(studentNames[index], `student${index + 1}`, hashPassword(`student${index + 1}23`), 'student')).lastInsertRowid));
    }
    const courseId = Number((await tx.prepare('INSERT INTO courses (name, code, instructor_id) VALUES (?, ?, ?)')
      .run('Introduction to Computer Science', 'CS101', instructorId)).lastInsertRowid);
    const enroll = tx.prepare('INSERT INTO enrollments (course_id, student_id) VALUES (?, ?)');
    for (const studentId of studentIds) await enroll.run(courseId, studentId);
  });
}

async function initializeDatabase() {
  if (usePostgres) {
    await database.exec(POSTGRES_SCHEMA);
    for (const name of ['BCA', 'BBA', 'B.Com', 'B.Sc']) {
      await database.prepare('INSERT INTO departments (name, year_count) VALUES (?, 3) ON CONFLICT (name) DO NOTHING').run(name);
    }
    const adminUsername = String(process.env.INITIAL_ADMIN_USERNAME || '').trim().toLowerCase();
    const adminPassword = String(process.env.INITIAL_ADMIN_PASSWORD || '');
    if (adminUsername || adminPassword) {
      if (!/^[a-z0-9][a-z0-9._/-]{1,39}$/.test(adminUsername) || adminPassword.length < 12 || adminPassword.length > 128) {
        throw new Error('Set INITIAL_ADMIN_USERNAME and a 12–128 character INITIAL_ADMIN_PASSWORD in the hosting secrets.');
      }
      const existing = await database.prepare('SELECT id, role FROM users WHERE username = ?').get(adminUsername);
      if (existing && existing.role !== 'admin') throw new Error('INITIAL_ADMIN_USERNAME is already used by a non-admin account.');
      if (!existing) {
        await database.prepare(`INSERT INTO users (name, username, password_hash, role, must_change_password)
          VALUES (?, ?, ?, 'admin', 1)`).run(process.env.INITIAL_ADMIN_NAME || 'College Administrator', adminUsername, hashPassword(adminPassword));
      }
    }
    const adminCount = Number((await database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get()).count);
    if (!adminCount) throw new Error('No admin account exists. Set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD in the hosting secrets.');
    return;
  }

  sqliteDatabase.exec(SQLITE_SCHEMA);
  migrateLocalUsersForAdminRole();
  migrateLocalUserActiveFlag();
  migrateLocalUserArchiveFlag();
  migrateLocalRecoveryEmailColumns();
  migrateLocalSessionInstructorSnapshot();
  sqliteDatabase.exec('DROP TABLE IF EXISTS face_templates');
  for (const name of ['BCA', 'BBA', 'B.Com', 'B.Sc']) {
    sqliteDatabase.prepare('INSERT OR IGNORE INTO departments (name, year_count) VALUES (?, 3)').run(name);
  }
  await seedLocalDemoDatabase();
  sqliteDatabase.prepare('INSERT OR IGNORE INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('RollCall Admin', 'admin', hashPassword('admin123'), 'admin');
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON body')); }
    });
    request.on('error', reject);
  });
}

async function currentUser(request) {
  const cookie = request.headers.cookie || '';
  const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  const session = value && sessions.get(value);
  if (!session || session.expiresAt <= Date.now()) {
    if (value) sessions.delete(value);
    return null;
  }
  const user = await database.prepare('SELECT id, name, username, role, must_change_password AS "mustChangePassword", is_active, is_archived FROM users WHERE id = ?').get(session.userId);
  if (!user || !Number(user.is_active) || Number(user.is_archived)) {
    sessions.delete(value);
    return null;
  }
  delete user.is_active;
  delete user.is_archived;
  return user;
}

async function userInfo(user) {
  if (!user) return user;
  const result = { ...user, mustChangePassword: Boolean(user.mustChangePassword) };
  if (user.role !== 'student') return result;
  const profile = await database.prepare(`SELECT p.department_id, d.name AS department_name, p.year_number
    FROM student_profiles p JOIN departments d ON d.id = p.department_id WHERE p.user_id = ?`).get(user.id);
  return { ...result, departmentId: profile?.department_id || null, departmentName: profile?.department_name || null, yearNumber: profile?.year_number || null };
}

function requireRole(user, role) {
  return user && user.role === role;
}

async function getCourse(courseId) {
  return await database.prepare('SELECT c.*, u.name AS instructor_name FROM courses c JOIN users u ON u.id = c.instructor_id WHERE c.id = ?').get(courseId);
}

async function getSession(sessionId) {
  return await database.prepare(`SELECT s.*, c.name AS course_name, c.code AS course_code
    FROM class_sessions s JOIN courses c ON c.id = s.course_id WHERE s.id = ?`).get(sessionId);
}

function issueQrToken(sessionId, bucket = Math.floor(Date.now() / 1000 / QR_WINDOW_SECONDS)) {
  const payload = `${sessionId}.${bucket}`;
  const signature = createHmac('sha256', QR_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function qrHostFor(request) {
  const requestHost = request.headers.host || 'localhost';
  const hostname = new URL(`http://${requestHost}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return requestHost;
  const addresses = Object.values(networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal);
  const lanAddress = addresses.find(item => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) || addresses[0];
  if (!lanAddress) return requestHost;
  const port = requestHost.match(/:(\d+)$/)?.[1];
  return `${lanAddress.address}${port ? `:${port}` : ''}`;
}

function validateQrToken(sessionId, token) {
  const currentBucket = Math.floor(Date.now() / 1000 / QR_WINDOW_SECONDS);
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== String(sessionId) || !/^\d+$/.test(parts[1])) return false;
  const tokenBucket = Number(parts[1]);
  // QR codes still rotate every 10 seconds, but give students time to sign in
  // and finish check-in after signing in.
  if (!Number.isSafeInteger(tokenBucket) || tokenBucket > currentBucket || currentBucket - tokenBucket > 6) return false;
  const expected = issueQrToken(sessionId, tokenBucket);
  const a = Buffer.from(expected);
  const b = Buffer.from(token || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function enrolled(courseId, studentId) {
  return Boolean(await database.prepare('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?').get(courseId, studentId));
}

async function getRoster(sessionId, filters = {}) {
  const conditions = ['s.id = ?'];
  const args = [sessionId];
  if (filters.departmentId) {
    conditions.push('p.department_id = ?');
    args.push(filters.departmentId);
  }
  if (filters.yearNumber) {
    conditions.push('p.year_number = ?');
    args.push(filters.yearNumber);
  }
  return (await database.prepare(`SELECT u.id AS student_id, u.name, u.username, a.method, a.marked_at,
      d.name AS department_name, p.department_id, p.year_number
    FROM class_sessions s
    JOIN enrollments e ON e.course_id = s.course_id
    JOIN users u ON u.id = e.student_id
    LEFT JOIN student_profiles p ON p.user_id = u.id
    LEFT JOIN departments d ON d.id = p.department_id
    LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = u.id
    WHERE ${conditions.join(' AND ')} ORDER BY d.name, p.year_number, u.name`).all(...args)).map(row => ({
      ...row,
      present: Boolean(row.method),
    }));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function makeCsv(session, roster, filters = {}) {
  const groupLabel = filters.departmentName
    ? `${filters.departmentName}${filters.yearNumber ? ` - ${filters.yearNumber}${filters.yearNumber === 1 ? 'st' : filters.yearNumber === 2 ? 'nd' : filters.yearNumber === 3 ? 'rd' : 'th'} Year` : ''}`
    : filters.yearNumber ? `${filters.yearNumber} Year` : 'All departments and years';
  const rows = [
    ['Course', session.course_name],
    ['Department filter', groupLabel],
    ['Session started', session.started_at],
    ['Session ended', session.ended_at || 'In progress'],
    [],
    ['Student name', 'Username', 'Department', 'Year', 'Status', 'Method', 'Marked at'],
    ...roster.map(row => [row.name, row.username, row.department_name || 'Not selected', row.year_number ? `${row.year_number} Year` : '', row.present ? 'Present' : 'Absent', row.method || '', row.marked_at || '']),
  ];
  return `\uFEFF${rows.map(row => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

async function reportFilters(url) {
  const departmentValue = url.searchParams.get('departmentId');
  const yearValue = url.searchParams.get('yearNumber');
  const departmentId = departmentValue ? Number(departmentValue) : null;
  const yearNumber = yearValue ? Number(yearValue) : null;
  if (departmentValue && (!Number.isInteger(departmentId) || departmentId < 1)) return { error: 'Invalid department filter.' };
  if (yearValue && (!Number.isInteger(yearNumber) || yearNumber < 1 || yearNumber > 6)) return { error: 'Invalid year filter.' };
  const department = departmentId ? await database.prepare('SELECT id, name, year_count FROM departments WHERE id = ?').get(departmentId) : null;
  if (departmentId && !department) return { error: 'Department not found.' };
  if (department && yearNumber && yearNumber > department.year_count) return { error: 'That department does not have this year group.' };
  return { departmentId, yearNumber, departmentName: department?.name || null };
}

function kolkataDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function kolkataDayBounds(dateKey) {
  // India Standard Time is UTC+05:30; timestamps in the database are UTC ISO strings.
  const start = new Date(`${dateKey}T00:00:00.000Z`).getTime() - (5 * 60 + 30) * 60_000;
  return [new Date(start).toISOString(), new Date(start + 86_400_000).toISOString()];
}

function isDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function dailyAttendanceCount(instructorId, dateKey) {
  const [start, end] = kolkataDayBounds(dateKey);
  const scope = instructorId ? 'AND s.instructor_id = ?' : '';
  const args = instructorId ? [start, end, instructorId] : [start, end];
  const result = await database.prepare(`SELECT COUNT(DISTINCT a.student_id) AS count
    FROM attendance a
    JOIN class_sessions s ON s.id = a.session_id
    JOIN courses c ON c.id = s.course_id
    WHERE a.marked_at >= ? AND a.marked_at < ? ${scope}`).get(...args);
  return Number(result.count);
}

async function handleApi(request, response, url) {
  const { method } = request;
  const pathname = url.pathname;
  let body;
  if (method === 'POST' || method === 'PATCH') {
    try { body = await readBody(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  }

  if (pathname === '/api/recovery-email/verify' && method === 'POST') {
    const token = String(body.token || '');
    if (token.length < 32 || token.length > 128) return sendJson(response, 400, { error: 'This verification link is invalid or expired.' });
    const tokenHash = hashOpaqueToken(token);
    const record = await database.prepare('SELECT user_id, email, expires_at FROM recovery_email_tokens WHERE token_hash = ?').get(tokenHash);
    if (!record || new Date(record.expires_at).getTime() <= Date.now()) return sendJson(response, 400, { error: 'This verification link is invalid or expired.' });
    const now = new Date().toISOString();
    await database.transaction(async tx => {
      const consumed = await tx.prepare('DELETE FROM recovery_email_tokens WHERE token_hash = ? AND expires_at > ?').run(tokenHash, now);
      if (!consumed.changes) throw new Error('Verification token was already used or expired.');
      await tx.prepare('UPDATE users SET recovery_email = ?, recovery_email_verified_at = ? WHERE id = ?').run(record.email, now, record.user_id);
      await tx.prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(now, record.user_id);
      await tx.prepare(`UPDATE password_reset_requests SET status = 'rejected', reviewed_at = ? WHERE user_id = ? AND status = 'approved'`).run(now, record.user_id);
    });
    return sendJson(response, 200, { message: 'Recovery email verified. You can now request a password reset.' });
  }

  if (pathname === '/api/password-reset/request' && method === 'POST') {
    try { appBaseUrl(); } catch (error) { return sendJson(response, 503, { error: error.message }); }
    if (!String(process.env.RESEND_API_KEY || '').trim() || !validEmail(process.env.MAIL_FROM_EMAIL)) {
      return sendJson(response, 503, { error: 'Password recovery email is temporarily unavailable. Please contact your administrator.' });
    }
    const role = String(body.accountType || '');
    const username = String(body.username || '').trim().toLowerCase();
    const rollNumber = String(body.rollNumber || '').trim().toLowerCase();
    if (!['student', 'instructor'].includes(role) || !/^[a-z0-9][a-z0-9._/-]{1,39}$/.test(username) || (role === 'student' && rollNumber !== username)) {
      return sendJson(response, 200, { message: 'If this account is eligible, its reset request will be sent for admin review. If you do not receive a reset email, contact your administrator.' });
    }
    const account = await database.prepare(`SELECT id, recovery_email, recovery_email_verified_at
      FROM users WHERE username = ? AND role = ? AND is_active = 1 AND is_archived = 0`).get(username, role);
    if (account && recoveryEmailVerified(account)) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();
      const recent = await database.prepare(`SELECT r.id FROM password_reset_requests r WHERE r.user_id = ? AND r.requested_at >= ? AND (
        r.status IN ('pending', 'rejected', 'completed') OR
        (r.status = 'approved' AND EXISTS (SELECT 1 FROM password_reset_tokens t WHERE t.request_id = r.id AND t.used_at IS NULL AND t.expires_at > ?))
      ) LIMIT 1`).get(account.id, since, now);
      if (!recent) {
        await database.prepare(`INSERT INTO password_reset_requests (user_id, requested_at, status) VALUES (?, ?, 'pending')`)
          .run(account.id, new Date().toISOString());
      }
    }
    return sendJson(response, 200, { message: 'If this account is eligible, its reset request will be sent for admin review. If you do not receive a reset email, contact your administrator.' });
  }

  if (pathname === '/api/password-reset/complete' && method === 'POST') {
    const token = String(body.token || '');
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 8 || newPassword.length > 128) return sendJson(response, 400, { error: 'Choose a password between 8 and 128 characters.' });
    if (token.length < 32 || token.length > 128) return sendJson(response, 400, { error: 'This reset link is invalid or expired.' });
    const tokenHash = hashOpaqueToken(token);
    const now = new Date().toISOString();
    let userId;
    try {
      await database.transaction(async tx => {
        const reset = await tx.prepare(`SELECT id, request_id, user_id FROM password_reset_tokens
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`).get(tokenHash, now);
        if (!reset) throw new Error('invalid-reset-link');
        const consumed = await tx.prepare(`UPDATE password_reset_tokens SET used_at = ?
          WHERE id = ? AND used_at IS NULL AND expires_at > ?`).run(now, reset.id, now);
        if (!consumed.changes) throw new Error('invalid-reset-link');
        const changed = await tx.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0
          WHERE id = ? AND is_active = 1 AND is_archived = 0`).run(hashPassword(newPassword), reset.user_id);
        if (!changed.changes) throw new Error('invalid-reset-link');
        const requestUpdate = await tx.prepare(`UPDATE password_reset_requests SET status = 'completed'
          WHERE id = ? AND user_id = ? AND status = 'approved'`).run(reset.request_id, reset.user_id);
        if (!requestUpdate.changes) throw new Error('invalid-reset-link');
        await tx.prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(now, reset.user_id);
        userId = Number(reset.user_id);
      });
    } catch (error) {
      if (error.message === 'invalid-reset-link') return sendJson(response, 400, { error: 'This reset link is invalid, expired, or already used.' });
      throw error;
    }
    invalidateUserSessions(userId);
    return sendJson(response, 200, { message: 'Password reset. You can sign in with your new password.' });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const user = await database.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1 AND is_archived = 0').get(String(body.username || '').trim().toLowerCase());
    if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) return sendJson(response, 401, { error: 'Username or password is incorrect.' });
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + COOKIE_TTL_MS });
    const safeUser = { id: user.id, name: user.name, username: user.username, role: user.role, mustChangePassword: Boolean(user.must_change_password) };
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return sendJson(response, 200, { user: await userInfo(safeUser) }, { 'set-cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_TTL_MS / 1000}${secureCookie}` });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const cookie = request.headers.cookie || '';
    const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    if (value) sessions.delete(value);
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return sendJson(response, 200, { ok: true }, { 'set-cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}` });
  }

  if (pathname === '/api/me' && method === 'GET') {
    const user = await currentUser(request);
    return user ? sendJson(response, 200, { user: await userInfo(user) }) : sendJson(response, 401, { error: 'Please sign in.' });
  }

  const user = await currentUser(request);
  if (!user) return sendJson(response, 401, { error: 'Please sign in to continue.' });

  if (pathname === '/api/me/password' && method === 'POST') {
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    const stored = await database.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!stored || !verifyPassword(currentPassword, stored.password_hash)) return sendJson(response, 400, { error: 'Current password is incorrect.' });
    if (newPassword.length < 8 || newPassword.length > 128) return sendJson(response, 400, { error: 'Choose a password between 8 and 128 characters.' });
    if (newPassword === currentPassword) return sendJson(response, 400, { error: 'Choose a password different from your temporary password.' });
    await database.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(newPassword), user.id);
    const updated = await database.prepare('SELECT id, name, username, role, must_change_password AS "mustChangePassword" FROM users WHERE id = ?').get(user.id);
    return sendJson(response, 200, { user: await userInfo(updated) });
  }

  if (user.mustChangePassword && pathname !== '/api/logout') {
    return sendJson(response, 403, { error: 'Change your temporary password before continuing.' });
  }

  if (pathname === '/api/me/recovery-email' && method === 'GET') {
    const account = await database.prepare('SELECT recovery_email, recovery_email_verified_at FROM users WHERE id = ?').get(user.id);
    return sendJson(response, 200, { email: account?.recovery_email || '', verified: Boolean(account?.recovery_email_verified_at) });
  }

  if (pathname === '/api/me/recovery-email' && method === 'POST') {
    const email = validEmail(body.email);
    if (!email) return sendJson(response, 400, { error: 'Enter a valid email address.' });
    const account = await database.prepare('SELECT recovery_email, recovery_email_verified_at FROM users WHERE id = ?').get(user.id);
    if (account?.recovery_email === email && account?.recovery_email_verified_at) return sendJson(response, 200, { message: 'That recovery email is already verified.' });
    try {
      await beginRecoveryEmailVerification(user.id, email);
      return sendJson(response, 200, { message: 'A verification link has been sent to that address. Your current verified address stays active until the new one is confirmed.' });
    } catch (error) {
      console.error('Could not send recovery email verification:', error.message);
      return sendJson(response, 503, { error: 'Could not send a verification email. Check the email service settings and try again.' });
    }
  }

  if (pathname === '/api/admin/recovery-accounts' && method === 'GET') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const accounts = await database.prepare(`SELECT id, name, username, role, is_active, is_archived,
        recovery_email, recovery_email_verified_at
      FROM users WHERE role IN ('student', 'instructor') ORDER BY role, name`).all();
    return sendJson(response, 200, { accounts });
  }

  const adminRecoveryEmailMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/recovery-email$/);
  if (adminRecoveryEmailMatch && method === 'POST') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const accountId = Number(adminRecoveryEmailMatch[1]);
    const email = validEmail(body.email);
    if (!email) return sendJson(response, 400, { error: 'Enter a valid email address.' });
    const account = await database.prepare("SELECT id FROM users WHERE id = ? AND role IN ('student', 'instructor')").get(accountId);
    if (!account) return sendJson(response, 404, { error: 'Student or instructor account not found.' });
    try {
      await beginRecoveryEmailVerification(accountId, email);
      return sendJson(response, 200, { message: 'A verification link has been sent. The address will be used for recovery only after it is confirmed.' });
    } catch (error) {
      console.error('Could not send admin-assisted recovery email verification:', error.message);
      return sendJson(response, 503, { error: 'Could not send a verification email. Check the email service settings and try again.' });
    }
  }

  if (pathname === '/api/admin/password-reset-requests' && method === 'GET') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const requests = await database.prepare(`SELECT r.id, r.user_id, r.requested_at, u.name, u.username, u.role,
        u.recovery_email, u.recovery_email_verified_at
      FROM password_reset_requests r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending' AND u.is_active = 1 AND u.is_archived = 0
      ORDER BY r.requested_at ASC LIMIT 100`).all();
    return sendJson(response, 200, { requests });
  }

  const resetReviewMatch = pathname.match(/^\/api\/admin\/password-reset-requests\/(\d+)\/(approve|reject)$/);
  if (resetReviewMatch && method === 'POST') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const requestId = Number(resetReviewMatch[1]);
    const action = resetReviewMatch[2];
    const resetRequest = await database.prepare(`SELECT r.id, r.user_id, r.status, u.name, u.username, u.role,
        u.recovery_email, u.recovery_email_verified_at, u.is_active, u.is_archived
      FROM password_reset_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?`).get(requestId);
    if (!resetRequest || resetRequest.status !== 'pending') return sendJson(response, 404, { error: 'Pending reset request not found.' });
    if (action === 'reject') {
      const rejected = await database.prepare(`UPDATE password_reset_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'`)
        .run(new Date().toISOString(), user.id, requestId);
      if (!rejected.changes) return sendJson(response, 409, { error: 'This request has already been reviewed.' });
      return sendJson(response, 200, { message: 'Reset request rejected.' });
    }
    if (!resetRequest.recovery_email || !resetRequest.recovery_email_verified_at || !Number(resetRequest.is_active) || Number(resetRequest.is_archived)) {
      return sendJson(response, 409, { error: 'The account no longer has an active, verified recovery email.' });
    }
    let baseUrl;
    try { baseUrl = appBaseUrl(); } catch (error) { return sendJson(response, 503, { error: error.message }); }
    const resetToken = opaqueToken();
    const resetHash = hashOpaqueToken(resetToken);
    const expiresAt = tokenExpiry(60);
    const reviewedAt = new Date().toISOString();
    await database.transaction(async tx => {
      await tx.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL').run(resetRequest.user_id);
      await tx.prepare('INSERT INTO password_reset_tokens (request_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
        .run(requestId, resetRequest.user_id, resetHash, expiresAt);
      const approved = await tx.prepare(`UPDATE password_reset_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'`)
        .run(reviewedAt, user.id, requestId);
      if (!approved.changes) throw new Error('Reset request was already reviewed.');
    });
    const link = `${baseUrl}/#reset-password=${resetToken}`;
    try {
      await sendEmail({
        to: resetRequest.recovery_email,
        subject: 'Your DIST Attendance password reset link',
        text: `Hello ${resetRequest.name},\n\nAn administrator approved your password reset request. This one-time link expires in one hour:\n\n${link}\n\nIf you did not request a reset, contact your college administrator.`,
      });
    } catch (error) {
      console.error('Could not send approved password reset email:', error.message);
      await database.transaction(async tx => {
        await tx.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL').run(resetHash);
        await tx.prepare(`UPDATE password_reset_requests SET status = 'pending', reviewed_at = NULL, reviewed_by = NULL WHERE id = ? AND status = 'approved'`)
          .run(requestId);
      });
      return sendJson(response, 503, { error: 'The reset email could not be sent. The request remains pending so you can retry after checking email settings.' });
    }
    return sendJson(response, 200, { message: `A one-time reset link was emailed to ${resetRequest.recovery_email}.` });
  }

  if (['/api/admin/students', '/api/instructor/students'].includes(pathname) && method === 'GET') {
    const instructorRequest = pathname === '/api/instructor/students';
    if (instructorRequest ? !requireRole(user, 'instructor') : !requireRole(user, 'admin')) return sendJson(response, 403, { error: instructorRequest ? 'Instructor access is required.' : 'Admin access is required.' });
    const today = kolkataDateKey(new Date());
    const [dayStart, dayEnd] = kolkataDayBounds(today);
    const attendanceInstructorFilter = instructorRequest ? 'AND attendance_course.instructor_id = ?' : '';
    const courseInstructorFilter = instructorRequest ? 'AND c.instructor_id = ?' : '';
    const courseAggregation = usePostgres ? "STRING_AGG(DISTINCT c.code, ',')" : 'GROUP_CONCAT(DISTINCT c.code)';
    const students = await database.prepare(`SELECT u.id, u.name, u.username AS roll_number,
        d.id AS department_id, d.name AS department_name, p.year_number,
        ${courseAggregation} AS course_codes,
        EXISTS (SELECT 1 FROM attendance a
          JOIN class_sessions attendance_session ON attendance_session.id = a.session_id
          JOIN courses attendance_course ON attendance_course.id = attendance_session.course_id
          WHERE a.student_id = u.id AND a.marked_at >= ? AND a.marked_at < ? ${attendanceInstructorFilter}) AS present_today
      FROM users u
      LEFT JOIN student_profiles p ON p.user_id = u.id
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN enrollments e ON e.student_id = u.id
      LEFT JOIN courses c ON c.id = e.course_id ${courseInstructorFilter}
      WHERE u.role = 'student' ${instructorRequest ? 'AND c.id IS NOT NULL' : ''}
      GROUP BY u.id, d.id, d.name, p.year_number ORDER BY u.name`).all(dayStart, dayEnd, ...(instructorRequest ? [user.id, user.id] : []));
    return sendJson(response, 200, { students });
  }

  if (['/api/admin/students', '/api/instructor/students'].includes(pathname) && method === 'POST') {
    const instructorRequest = pathname === '/api/instructor/students';
    if (instructorRequest ? !requireRole(user, 'instructor') : !requireRole(user, 'admin')) return sendJson(response, 403, { error: instructorRequest ? 'Instructor access is required.' : 'Admin access is required.' });
    const name = String(body.name || '').trim();
    const rollNumber = String(body.rollNumber || '').trim().toLowerCase();
    const password = String(body.temporaryPassword || '');
    const departmentId = Number(body.departmentId);
    const yearNumber = Number(body.yearNumber);
    const courseId = Number(body.courseId);
    if (!name || name.length > 100) return sendJson(response, 400, { error: 'Enter the student’s name (up to 100 characters).' });
    if (!/^[a-z0-9][a-z0-9._/-]{1,39}$/.test(rollNumber)) return sendJson(response, 400, { error: 'Enter a roll number using 2–40 letters, numbers, dots, dashes, slashes, or underscores.' });
    if (password.length < 8 || password.length > 128) return sendJson(response, 400, { error: 'Temporary password must be 8–128 characters.' });
    const department = await database.prepare('SELECT id, year_count FROM departments WHERE id = ?').get(departmentId);
    if (!department || !Number.isInteger(yearNumber) || yearNumber < 1 || yearNumber > department.year_count) return sendJson(response, 400, { error: 'Choose a valid department and year.' });
    const course = await database.prepare(`SELECT c.id, c.instructor_id FROM courses c JOIN users teacher ON teacher.id = c.instructor_id AND teacher.is_active = 1 AND teacher.is_archived = 0 WHERE c.id = ?`).get(courseId);
    if (!course || (instructorRequest && course.instructor_id !== user.id)) return sendJson(response, 400, { error: 'Choose one of your courses.' });
    if (await database.prepare('SELECT id FROM users WHERE username = ?').get(rollNumber)) return sendJson(response, 409, { error: 'That roll number is already in use.' });

    try {
      const studentId = await database.transaction(async tx => {
        const inserted = await tx.prepare(`INSERT INTO users (name, username, password_hash, role, must_change_password)
          VALUES (?, ?, ?, 'student', 1)${usePostgres ? ' RETURNING id' : ''}`).run(name, rollNumber, hashPassword(password));
        const id = Number(inserted.lastInsertRowid);
        const now = new Date().toISOString();
        await tx.prepare('INSERT INTO student_profiles (user_id, department_id, year_number, updated_at) VALUES (?, ?, ?, ?)').run(id, departmentId, yearNumber, now);
        await tx.prepare('INSERT INTO enrollments (course_id, student_id) VALUES (?, ?)').run(courseId, id);
        return id;
      });
      return sendJson(response, 201, { student: { id: studentId, name, rollNumber, departmentId, yearNumber, courseId } });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: users.username')) return sendJson(response, 409, { error: 'That roll number is already in use.' });
      if (error.code === '23505' && String(error.constraint || '').includes('username')) return sendJson(response, 409, { error: 'That roll number is already in use.' });
      throw error;
    }
  }

  const studentGroupMatch = pathname.match(/^\/api\/admin\/students\/(\d+)\/group$/);
  if (studentGroupMatch && method === 'POST') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const studentId = Number(studentGroupMatch[1]);
    const student = await database.prepare("SELECT id, name, username FROM users WHERE id = ? AND role = 'student'").get(studentId);
    if (!student) return sendJson(response, 404, { error: 'Student not found.' });
    const departmentId = Number(body.departmentId);
    const yearNumber = Number(body.yearNumber);
    const department = await database.prepare('SELECT id, name, year_count FROM departments WHERE id = ?').get(departmentId);
    if (!department) return sendJson(response, 400, { error: 'Choose a valid department.' });
    if (!Number.isInteger(yearNumber) || yearNumber < 1 || yearNumber > department.year_count) {
      return sendJson(response, 400, { error: 'Choose a valid year for this department.' });
    }
    await database.prepare(`INSERT INTO student_profiles (user_id, department_id, year_number, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET department_id = excluded.department_id, year_number = excluded.year_number, updated_at = excluded.updated_at`)
      .run(studentId, department.id, yearNumber, new Date().toISOString());
    return sendJson(response, 200, { student: { ...student, department_id: department.id, department_name: department.name, year_number: yearNumber } });
  }

  if (pathname === '/api/admin/courses' && method === 'GET') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const courses = await database.prepare(`SELECT c.id, c.name, c.code, c.instructor_id, u.name AS instructor_name, u.is_active AS instructor_is_active, u.is_archived AS instructor_is_archived
      FROM courses c JOIN users u ON u.id = c.instructor_id ORDER BY c.name`).all();
    return sendJson(response, 200, { courses });
  }

  if (pathname === '/api/admin/instructors' && method === 'GET') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const instructors = await database.prepare("SELECT id, name, username FROM users WHERE role = 'instructor' AND is_active = 1 AND is_archived = 0 ORDER BY name").all();
    const inactiveInstructors = await database.prepare("SELECT id, name, username FROM users WHERE role = 'instructor' AND is_active = 0 AND is_archived = 0 ORDER BY name").all();
    const archivedInstructors = await database.prepare("SELECT id, name, username FROM users WHERE role = 'instructor' AND is_archived = 1 ORDER BY name").all();
    return sendJson(response, 200, { instructors, inactiveInstructors, archivedInstructors });
  }

  const instructorPasswordResetMatch = pathname.match(/^\/api\/admin\/instructors\/(\d+)\/password$/);
  if (instructorPasswordResetMatch && method === 'POST') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const instructorId = Number(instructorPasswordResetMatch[1]);
    const password = String(body.temporaryPassword || '');
    if (password.length < 8 || password.length > 128) return sendJson(response, 400, { error: 'Temporary password must be 8–128 characters.' });
    const instructor = await database.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'instructor' AND is_active = 1 AND is_archived = 0").get(instructorId);
    if (!instructor) return sendJson(response, 404, { error: 'Active instructor not found.' });
    const now = new Date().toISOString();
    await database.transaction(async tx => {
      await tx.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), instructorId);
      await tx.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, instructorId);
      await tx.prepare(`UPDATE password_reset_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ?
        WHERE user_id = ? AND status IN ('pending', 'approved')`).run(now, user.id, instructorId);
    });
    for (const [token, session] of sessions) if (Number(session.userId) === instructorId) sessions.delete(token);
    return sendJson(response, 200, { instructor: { id: instructorId, name: instructor.name }, mustChangePassword: true });
  }

  const instructorActionMatch = pathname.match(/^\/api\/admin\/instructors\/(\d+)(?:\/(restore))?$/);
  if (instructorActionMatch && ['DELETE', 'POST'].includes(method)) {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const instructorId = Number(instructorActionMatch[1]);
    const restoring = Boolean(instructorActionMatch[2]);
    if ((restoring && method !== 'POST') || (!restoring && method !== 'DELETE')) return sendJson(response, 405, { error: 'Method not allowed.' });
    const instructor = await database.prepare("SELECT id, name, is_active, is_archived FROM users WHERE id = ? AND role = 'instructor'").get(instructorId);
    if (!instructor) return sendJson(response, 404, { error: 'Instructor not found.' });
    if (restoring) {
      await database.prepare('UPDATE users SET is_active = 1, is_archived = 0 WHERE id = ?').run(instructorId);
      return sendJson(response, 200, { instructor: { id: instructorId, name: instructor.name, isActive: true } });
    }
    let endedSessions = 0;
    await database.transaction(async tx => {
      await tx.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(instructorId);
      endedSessions = (await tx.prepare('UPDATE class_sessions SET ended_at = ? WHERE instructor_id = ? AND ended_at IS NULL').run(new Date().toISOString(), instructorId)).changes;
    });
    for (const [token, session] of sessions) if (Number(session.userId) === instructorId) sessions.delete(token);
    return sendJson(response, 200, { instructor: { id: instructorId, name: instructor.name, isActive: false }, endedSessions });
  }

  const instructorArchiveMatch = pathname.match(/^\/api\/admin\/instructors\/(\d+)\/archive$/);
  if (instructorArchiveMatch && method === 'POST') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const instructorId = Number(instructorArchiveMatch[1]);
    const instructor = await database.prepare("SELECT id, name, is_archived FROM users WHERE id = ? AND role = 'instructor'").get(instructorId);
    if (!instructor) return sendJson(response, 404, { error: 'Instructor not found.' });
    let endedSessions = 0;
    await database.transaction(async tx => {
      await tx.prepare('UPDATE users SET is_active = 0, is_archived = 1 WHERE id = ?').run(instructorId);
      endedSessions = (await tx.prepare('UPDATE class_sessions SET ended_at = ? WHERE instructor_id = ? AND ended_at IS NULL').run(new Date().toISOString(), instructorId)).changes;
    });
    for (const [token, session] of sessions) if (Number(session.userId) === instructorId) sessions.delete(token);
    return sendJson(response, 200, { instructor: { id: instructorId, name: instructor.name, isArchived: true }, endedSessions });
  }

  const courseReassignMatch = pathname.match(/^\/api\/admin\/courses\/(\d+)\/instructor$/);
  if (courseReassignMatch && method === 'PATCH') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const courseId = Number(courseReassignMatch[1]);
    const instructorId = Number(body.instructorId);
    const course = await database.prepare('SELECT id, name, code FROM courses WHERE id = ?').get(courseId);
    if (!course) return sendJson(response, 404, { error: 'Course not found.' });
    const instructor = await database.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'instructor' AND is_active = 1 AND is_archived = 0").get(instructorId);
    if (!instructor) return sendJson(response, 400, { error: 'Choose an active instructor.' });
    await database.prepare('UPDATE courses SET instructor_id = ? WHERE id = ?').run(instructorId, courseId);
    return sendJson(response, 200, { course: { ...course, instructor_id: instructorId, instructor_name: instructor.name } });
  }

  if (pathname === '/api/admin/instructors' && method === 'POST') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const name = String(body.name || '').trim();
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.temporaryPassword || '');
    if (!name || name.length > 100) return sendJson(response, 400, { error: 'Enter the instructor’s name (up to 100 characters).' });
    if (!/^[a-z0-9][a-z0-9._/-]{1,39}$/.test(username)) return sendJson(response, 400, { error: 'Enter a username using 2–40 letters, numbers, dots, dashes, slashes, or underscores.' });
    if (password.length < 8 || password.length > 128) return sendJson(response, 400, { error: 'Temporary password must be 8–128 characters.' });
    try {
      const inserted = await database.prepare(`INSERT INTO users (name, username, password_hash, role, must_change_password)
        VALUES (?, ?, ?, 'instructor', 1)${usePostgres ? ' RETURNING id' : ''}`).run(name, username, hashPassword(password));
      return sendJson(response, 201, { instructor: { id: Number(inserted.lastInsertRowid), name, username, mustChangePassword: true } });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: users.username')) return sendJson(response, 409, { error: 'That username is already in use.' });
      if (error.code === '23505' && String(error.constraint || '').includes('username')) return sendJson(response, 409, { error: 'That username is already in use.' });
      throw error;
    }
  }

  if (pathname === '/api/admin/sessions' && method === 'GET') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const sessions = await database.prepare(`SELECT s.*, c.name AS course_name, c.code AS course_code, COALESCE(s.instructor_name_snapshot, u.name) AS instructor_name,
        (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS present_count,
        (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = s.course_id) AS roster_count
      FROM class_sessions s JOIN courses c ON c.id = s.course_id JOIN users u ON u.id = s.instructor_id
      ORDER BY s.id DESC LIMIT 20`).all();
    return sendJson(response, 200, { sessions });
  }

  if (pathname === '/api/courses' && method === 'POST') {
    if (!['admin', 'instructor'].includes(user.role)) return sendJson(response, 403, { error: 'Admin or instructor access is required.' });
    const name = String(body.name || '').trim();
    const code = String(body.code || '').trim().toUpperCase();
    if (!name || name.length > 100) return sendJson(response, 400, { error: 'Enter a course name (up to 100 characters).' });
    if (!/^[A-Z0-9][A-Z0-9._-]{1,19}$/.test(code)) return sendJson(response, 400, { error: 'Enter a course code using 2–20 letters, numbers, dots, dashes, or underscores.' });
    let instructorId = user.id;
    if (user.role === 'admin') {
      instructorId = Number(body.instructorId);
      if (!Number.isInteger(instructorId) || !await database.prepare("SELECT id FROM users WHERE id = ? AND role = 'instructor' AND is_active = 1 AND is_archived = 0").get(instructorId)) {
        return sendJson(response, 400, { error: 'Choose an instructor for this course.' });
      }
    }
    try {
      const inserted = await database.prepare(`INSERT INTO courses (name, code, instructor_id) VALUES (?, ?, ?)${usePostgres ? ' RETURNING id' : ''}`).run(name, code, instructorId);
      return sendJson(response, 201, { course: { id: Number(inserted.lastInsertRowid), name, code, instructorId } });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: courses.code')) return sendJson(response, 409, { error: 'That course code is already in use.' });
      if (error.code === '23505' && String(error.constraint || '').includes('code')) return sendJson(response, 409, { error: 'That course code is already in use.' });
      throw error;
    }
  }

  if (pathname === '/api/departments' && method === 'GET') {
    const departments = await database.prepare(`SELECT d.*,
        (SELECT COUNT(*) FROM student_profiles p WHERE p.department_id = d.id) AS student_count
      FROM departments d ORDER BY d.name`).all();
    return sendJson(response, 200, { departments });
  }

  const departmentDeleteMatch = pathname.match(/^\/api\/departments\/(\d+)$/);
  if (departmentDeleteMatch && method === 'DELETE') {
    if (!requireRole(user, 'admin')) return sendJson(response, 403, { error: 'Admin access is required.' });
    const departmentId = Number(departmentDeleteMatch[1]);
    const department = await database.prepare('SELECT id, name FROM departments WHERE id = ?').get(departmentId);
    if (!department) return sendJson(response, 404, { error: 'Department not found.' });
    const assigned = Number((await database.prepare('SELECT COUNT(*) AS count FROM student_profiles WHERE department_id = ?').get(departmentId)).count);
    try {
      await database.transaction(async tx => {
        await tx.prepare('DELETE FROM student_profiles WHERE department_id = ?').run(departmentId);
        await tx.prepare('DELETE FROM departments WHERE id = ?').run(departmentId);
      });
      return sendJson(response, 200, { deleted: { id: departmentId, name: department.name, unassignedStudents: assigned } });
    } catch (error) {
      throw error;
    }
  }

  if (pathname === '/api/reports/daily-attendance' && method === 'GET') {
    if (!['instructor', 'admin'].includes(user.role)) return sendJson(response, 403, { error: 'Instructor or admin access is required.' });
    const today = kolkataDateKey(new Date());
    const yesterday = shiftDateKey(today, -1);
    const instructorId = user.role === 'instructor' ? user.id : null;
    return sendJson(response, 200, {
      timeZone: 'Asia/Kolkata',
      today: { date: today, count: await dailyAttendanceCount(instructorId, today) },
      yesterday: { date: yesterday, count: await dailyAttendanceCount(instructorId, yesterday) },
    });
  }

  if (pathname === '/api/reports/attendance/by-date' && method === 'GET') {
    if (!['instructor', 'admin'].includes(user.role)) return sendJson(response, 403, { error: 'Instructor or admin access is required.' });
    const date = url.searchParams.get('date') || kolkataDateKey(new Date());
    if (!isDateKey(date)) return sendJson(response, 400, { error: 'Choose a valid date.' });
    const [start, end] = kolkataDayBounds(date);
    const instructorFilter = user.role === 'instructor' ? 'AND s.instructor_id = ?' : '';
    const params = user.role === 'instructor' ? [start, end, user.id] : [start, end];
    const attendance = await database.prepare(`SELECT a.student_id, u.name AS student_name, u.username AS roll_number,
        d.name AS department_name, p.year_number, a.method, a.marked_at,
        s.id AS session_id, s.started_at AS session_started_at, s.ended_at AS session_ended_at,
        c.name AS course_name, c.code AS course_code
      FROM attendance a
      JOIN users u ON u.id = a.student_id
      JOIN class_sessions s ON s.id = a.session_id
      JOIN courses c ON c.id = s.course_id
      LEFT JOIN student_profiles p ON p.user_id = u.id
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE a.marked_at >= ? AND a.marked_at < ? ${instructorFilter}
      ORDER BY u.name, a.marked_at`).all(...params);
    return sendJson(response, 200, { date, attendance });
  }

  const studentAttendanceMatch = pathname.match(/^\/api\/reports\/attendance\/students\/(\d+)$/);
  if (studentAttendanceMatch && method === 'GET') {
    if (!['instructor', 'admin'].includes(user.role)) return sendJson(response, 403, { error: 'Instructor or admin access is required.' });
    const studentId = Number(studentAttendanceMatch[1]);
    const student = await database.prepare("SELECT id, name, username AS roll_number FROM users WHERE id = ? AND role = 'student'").get(studentId);
    if (!student) return sendJson(response, 404, { error: 'Student not found.' });
    const instructorFilter = user.role === 'instructor' ? 'AND s.instructor_id = ?' : '';
    const accessible = user.role === 'admin' || Boolean(await database.prepare(`SELECT 1
      FROM enrollments e JOIN courses c ON c.id = e.course_id
      WHERE e.student_id = ? AND c.instructor_id = ? LIMIT 1`).get(studentId, user.id));
    if (!accessible) return sendJson(response, 404, { error: 'Student not found.' });
    const params = user.role === 'instructor' ? [studentId, user.id] : [studentId];
    const attendance = (await database.prepare(`SELECT a.method, a.marked_at,
        s.id AS session_id, s.started_at AS session_started_at, s.ended_at AS session_ended_at,
        c.name AS course_name, c.code AS course_code
      FROM attendance a
      JOIN class_sessions s ON s.id = a.session_id
      JOIN courses c ON c.id = s.course_id
      WHERE a.student_id = ? ${instructorFilter}
      ORDER BY a.marked_at DESC`).all(...params)).map(row => ({
        ...row,
        attendance_date: kolkataDateKey(new Date(row.marked_at)),
      }));
    return sendJson(response, 200, { student, attendance });
  }

  if (pathname === '/api/departments' && method === 'POST') {
    if (!requireRole(user, 'instructor')) return sendJson(response, 403, { error: 'Instructor access is required.' });
    const name = String(body.name || '').trim();
    const yearCount = Number(body.yearCount || 3);
    if (!name || name.length > 50) return sendJson(response, 400, { error: 'Enter a department name of up to 50 characters.' });
    if (!Number.isInteger(yearCount) || yearCount < 1 || yearCount > 6) return sendJson(response, 400, { error: 'Year count must be from 1 to 6.' });
    const duplicateQuery = usePostgres ? 'SELECT id FROM departments WHERE LOWER(name) = LOWER(?)' : 'SELECT id FROM departments WHERE name = ? COLLATE NOCASE';
    if (await database.prepare(duplicateQuery).get(name)) return sendJson(response, 409, { error: 'That department already exists.' });
    const result = await database.prepare(`INSERT INTO departments (name, year_count) VALUES (?, ?)${usePostgres ? ' RETURNING id' : ''}`).run(name, yearCount);
    const department = await database.prepare('SELECT * FROM departments WHERE id = ?').get(Number(result.lastInsertRowid));
    return sendJson(response, 201, { department });
  }

  if (pathname === '/api/me/profile' && method === 'POST') {
    if (!requireRole(user, 'student')) return sendJson(response, 403, { error: 'Student access is required.' });
    const departmentId = Number(body.departmentId);
    const yearNumber = Number(body.yearNumber);
    const department = await database.prepare('SELECT * FROM departments WHERE id = ?').get(departmentId);
    if (!department) return sendJson(response, 400, { error: 'Choose a department.' });
    if (!Number.isInteger(yearNumber) || yearNumber < 1 || yearNumber > department.year_count) return sendJson(response, 400, { error: 'Choose a valid year for this department.' });
    await database.prepare(`INSERT INTO student_profiles (user_id, department_id, year_number, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET department_id = excluded.department_id, year_number = excluded.year_number, updated_at = excluded.updated_at`)
      .run(user.id, department.id, yearNumber, new Date().toISOString());
    return sendJson(response, 200, { user: await userInfo(user) });
  }

  if (pathname === '/api/courses' && method === 'GET') {
    const courses = user.role === 'instructor'
      ? await database.prepare('SELECT * FROM courses WHERE instructor_id = ? ORDER BY name').all(user.id)
      : await database.prepare(`SELECT c.* FROM courses c JOIN enrollments e ON e.course_id = c.id WHERE e.student_id = ? ORDER BY c.name`).all(user.id);
    return sendJson(response, 200, { courses });
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    if (!requireRole(user, 'instructor')) return sendJson(response, 403, { error: 'Instructor access is required.' });
    const rows = await database.prepare(`SELECT s.*, c.name AS course_name, c.code AS course_code,
        (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS present_count,
        (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = s.course_id) AS roster_count
      FROM class_sessions s JOIN courses c ON c.id = s.course_id WHERE s.instructor_id = ? ORDER BY s.id DESC LIMIT 20`).all(user.id);
    return sendJson(response, 200, { sessions: rows });
  }

  if (pathname === '/api/sessions' && method === 'POST') {
    if (!requireRole(user, 'instructor')) return sendJson(response, 403, { error: 'Instructor access is required.' });
    const course = await getCourse(Number(body.courseId));
    if (!course || course.instructor_id !== user.id) return sendJson(response, 404, { error: 'Course not found.' });
    const active = await database.prepare('SELECT id FROM class_sessions WHERE course_id = ? AND ended_at IS NULL').get(course.id);
    if (active) return sendJson(response, 409, { error: 'End the active session before starting another.' });
    const now = new Date().toISOString();
    const result = await database.prepare(`INSERT INTO class_sessions (course_id, instructor_id, started_at) VALUES (?, ?, ?)${usePostgres ? ' RETURNING id' : ''}`).run(course.id, user.id, now);
    return sendJson(response, 201, { session: await getSession(Number(result.lastInsertRowid)) });
  }

  const endMatch = pathname.match(/^\/api\/sessions\/(\d+)\/end$/);
  if (endMatch && method === 'POST') {
    if (!requireRole(user, 'instructor')) return sendJson(response, 403, { error: 'Instructor access is required.' });
    const session = await getSession(Number(endMatch[1]));
    if (!session || session.instructor_id !== user.id) return sendJson(response, 404, { error: 'Session not found.' });
    if (!session.ended_at) await database.prepare('UPDATE class_sessions SET ended_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
    return sendJson(response, 200, { session: await getSession(session.id) });
  }

  const qrMatch = pathname.match(/^\/api\/sessions\/(\d+)\/qr$/);
  if (qrMatch && method === 'GET') {
    if (!requireRole(user, 'instructor')) return sendJson(response, 403, { error: 'Instructor access is required.' });
    const session = await getSession(Number(qrMatch[1]));
    if (!session || session.instructor_id !== user.id) return sendJson(response, 404, { error: 'Session not found.' });
    if (session.ended_at) return sendJson(response, 409, { error: 'This session has ended.' });
    const token = issueQrToken(session.id);
    const origin = `${url.protocol}//${qrHostFor(request)}`;
    const checkinUrl = new URL('/checkin', origin);
    checkinUrl.searchParams.set('sessionId', String(session.id));
    checkinUrl.searchParams.set('token', token);
    const qr = spawnSync(process.env.PYTHON || 'python', [join(ROOT, 'qr.py'), checkinUrl.toString()], { encoding: 'utf8', timeout: 3000 });
    if (qr.status !== 0) {
      console.error('QR generation failed:', qr.stderr || qr.error?.message);
      return sendJson(response, 503, { error: 'QR generator is unavailable. Install Python and run pip install -r requirements.txt.' });
    }
    return sendJson(response, 200, { checkinUrl: checkinUrl.toString(), svg: qr.stdout, expiresIn: QR_WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % QR_WINDOW_SECONDS) });
  }

  if (pathname === '/api/attendance/check-in' && method === 'POST') {
    if (!requireRole(user, 'student')) return sendJson(response, 403, { error: 'Student access is required.' });
    const sessionId = Number(body.sessionId);
    const session = await getSession(sessionId);
    if (!session || session.ended_at) return sendJson(response, 410, { error: 'This class session is no longer active.' });
    if (!validateQrToken(sessionId, String(body.token || ''))) return sendJson(response, 410, { error: 'This QR code has expired. Scan the latest code.' });
    if (!await enrolled(session.course_id, user.id)) return sendJson(response, 403, { error: 'You are not on this course roster.' });
    const existing = await database.prepare('SELECT method, marked_at FROM attendance WHERE session_id = ? AND student_id = ?').get(sessionId, user.id);
    if (existing) return sendJson(response, 200, { message: 'Your attendance is already recorded.', attendance: existing, alreadyPresent: true });
    const markedAt = new Date().toISOString();
    await database.prepare('INSERT INTO attendance (session_id, student_id, method, marked_at) VALUES (?, ?, ?, ?)').run(sessionId, user.id, 'qr', markedAt);
    return sendJson(response, 201, { message: 'Attendance recorded.', attendance: { method: 'qr', marked_at: markedAt }, alreadyPresent: false });
  }

  const rosterMatch = pathname.match(/^\/api\/sessions\/(\d+)\/attendance$/);
  if (rosterMatch && method === 'GET') {
    const session = await getSession(Number(rosterMatch[1]));
    if (!session || (user.role !== 'admin' && (user.role !== 'instructor' || session.instructor_id !== user.id))) return sendJson(response, 404, { error: 'Session not found.' });
    const courseValue = url.searchParams.get('courseId');
    if (courseValue && (!/^\d+$/.test(courseValue) || Number(courseValue) !== session.course_id)) return sendJson(response, 400, { error: 'Choose a session from the selected course.' });
    const filters = await reportFilters(url);
    if (filters.error) return sendJson(response, 400, { error: filters.error });
    return sendJson(response, 200, { session, filters, roster: await getRoster(session.id, filters) });
  }

  const manualMatch = pathname.match(/^\/api\/sessions\/(\d+)\/attendance\/manual$/);
  if (manualMatch && method === 'POST') {
    if (!['admin', 'instructor'].includes(user.role)) return sendJson(response, 403, { error: 'Admin or instructor access is required.' });
    const session = await getSession(Number(manualMatch[1]));
    const studentId = Number(body.studentId);
    if (!session || (user.role === 'instructor' && session.instructor_id !== user.id)) return sendJson(response, 404, { error: 'Session not found.' });
    if (!await enrolled(session.course_id, studentId)) return sendJson(response, 400, { error: 'Student is not enrolled in this course.' });
    if (await database.prepare('SELECT 1 FROM attendance WHERE session_id = ? AND student_id = ?').get(session.id, studentId)) return sendJson(response, 409, { error: 'Attendance is already recorded for this student.' });
    const markedAt = new Date().toISOString();
    await database.prepare("INSERT INTO attendance (session_id, student_id, method, marked_at) VALUES (?, ?, 'manual', ?)").run(session.id, studentId, markedAt);
    return sendJson(response, 201, { roster: await getRoster(session.id) });
  }

  const csvMatch = pathname.match(/^\/api\/sessions\/(\d+)\/export\.csv$/);
  if (csvMatch && method === 'GET') {
    if (!requireRole(user, 'instructor')) return sendJson(response, 403, { error: 'Instructor access is required.' });
    const session = await getSession(Number(csvMatch[1]));
    if (!session || session.instructor_id !== user.id) return sendJson(response, 404, { error: 'Session not found.' });
    const filters = await reportFilters(url);
    if (filters.error) return sendJson(response, 400, { error: filters.error });
    const filename = `attendance-${session.course_code.toLowerCase()}-session-${session.id}.csv`;
    response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' });
    response.end(makeCsv(session, await getRoster(session.id, filters), filters));
    return;
  }

  return sendJson(response, 404, { error: 'API endpoint not found.' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveStatic(response, pathname) {
  const requested = pathname === '/' || pathname === '/checkin' ? '/index.html' : pathname;
  const safePath = normalize(requested).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
  const path = join(PUBLIC_DIR, safePath);
  if (!path.startsWith(PUBLIC_DIR)) {
    response.writeHead(403); response.end('Forbidden'); return;
  }
  try {
    const data = await readFile(path);
    response.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(data);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

const server = createServer(async (request, response) => {
  try {
    const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = process.env.NODE_ENV === 'production' && forwardedProtocol === 'https' ? 'https' : 'http';
    const url = new URL(request.url, `${protocol}://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/health' && request.method === 'GET') {
      if (usePostgres) await postgresPool.query('SELECT 1');
      else sqliteDatabase.prepare('SELECT 1').get();
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('ok');
      return;
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong. Please try again.' });
    else response.end();
  }
});

initializeDatabase().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`Attendance app running at http://localhost:${PORT}`);
    if (!usePostgres && process.env.NODE_ENV !== 'production') console.log('Local demo logins: instructor / teach123, student1 / student123, admin / admin123');
  });
}).catch(async error => {
  console.error(`Database startup failed: ${error.message}`);
  await database.close().catch(() => {});
  process.exitCode = 1;
});

function shutdown() {
  server.close(async () => { await database.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
