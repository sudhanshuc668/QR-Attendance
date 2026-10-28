import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
const replacementName = String(process.env.REPLACEMENT_INSTRUCTOR_NAME || '').trim();
const replacementUsername = String(process.env.REPLACEMENT_INSTRUCTOR_USERNAME || '').trim().toLowerCase();
const replacementPassword = String(process.env.REPLACEMENT_INSTRUCTOR_TEMP_PASSWORD || '');
const execute = process.argv.includes('--execute');
const backupPath = resolve(process.env.INSTRUCTOR_MIGRATION_BACKUP || `backups/instructors-before-removal-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
const databaseUrl = connectionString ? new URL(connectionString) : null;

if (!connectionString) throw new Error('DATABASE_URL is required. Use the hosted PostgreSQL connection string through a secure environment prompt.');
if (execute && (!replacementName || replacementName.length > 100)) throw new Error('Set REPLACEMENT_INSTRUCTOR_NAME (1-100 characters).');
if (execute && !/^[a-z0-9][a-z0-9._/-]{1,39}$/.test(replacementUsername)) throw new Error('Set a valid REPLACEMENT_INSTRUCTOR_USERNAME (2-40 lowercase letters, numbers, dots, dashes, slashes, or underscores).');
if (execute && (replacementPassword.length < 8 || replacementPassword.length > 128)) throw new Error('Set REPLACEMENT_INSTRUCTOR_TEMP_PASSWORD (8-128 characters).');

const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 10000, ssl: /\.neon\.tech$/i.test(new URL(connectionString).hostname) ? { rejectUnauthorized: true } : undefined });

async function readImpact(client) {
  const instructors = await client.query(`SELECT u.id, u.name, u.username, u.is_active, u.is_archived,
      (SELECT COUNT(*)::int FROM courses c WHERE c.instructor_id = u.id) AS course_count,
      (SELECT COUNT(*)::int FROM class_sessions s WHERE s.instructor_id = u.id) AS session_count,
      (SELECT COUNT(*)::int FROM attendance a JOIN class_sessions s ON s.id = a.session_id WHERE s.instructor_id = u.id) AS attendance_count
    FROM users u WHERE u.role = 'instructor' ORDER BY u.name, u.id`);
  const courses = await client.query(`SELECT c.id, c.code, c.name, c.instructor_id, u.name AS instructor_name
    FROM courses c JOIN users u ON u.id = c.instructor_id
    WHERE u.role = 'instructor' ORDER BY c.code, c.id`);
  const totals = instructors.rows.reduce((sum, item) => ({
    instructors: sum.instructors + 1,
    courses: sum.courses + item.course_count,
    sessions: sum.sessions + item.session_count,
    attendance: sum.attendance + item.attendance_count,
  }), { instructors: 0, courses: 0, sessions: 0, attendance: 0 });
  return { instructors: instructors.rows, courses: courses.rows, totals };
}

function printImpact(impact, replacementConflict) {
  stdout.write('\nHosted database impact preview\n');
  stdout.write(`Target PostgreSQL: ${databaseUrl.hostname}/${decodeURIComponent(databaseUrl.pathname.slice(1))}\n`);
  stdout.write(`Instructor accounts to delete: ${impact.totals.instructors}\n`);
  stdout.write(`Courses to reassign: ${impact.totals.courses}\n`);
  stdout.write(`Historical sessions to relink: ${impact.totals.sessions}\n`);
  stdout.write(`Attendance rows retained: ${impact.totals.attendance}\n`);
  stdout.write('Instructor accounts (active / deactivated / archived):\n');
  for (const item of impact.instructors) {
    const state = Number(item.is_archived) ? 'archived' : Number(item.is_active) ? 'active' : 'deactivated';
    stdout.write(`  - ${item.name} (${item.username}) — ${state}; ${item.course_count} courses, ${item.session_count} sessions\n`);
  }
  if (impact.courses.length) {
    stdout.write('Course assignments:\n');
    for (const item of impact.courses) stdout.write(`  - ${item.code} · ${item.name} — ${item.instructor_name}\n`);
  }
  stdout.write(`Replacement username ${replacementUsername || '(not supplied)'}: ${replacementConflict ? 'already exists; migration will stop' : 'available'}\n`);
  stdout.write('Existing student accounts, enrollments, courses, sessions, and attendance are retained. Session history keeps its original instructor name.\n');
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function makeBackup() {
  const parsed = databaseUrl;
  mkdirSync(dirname(backupPath), { recursive: true });
  const args = ['--format=custom', '--no-owner', '--no-acl', '--file', backupPath,
    '--host', parsed.hostname, '--port', parsed.port || '5432', '--username', decodeURIComponent(parsed.username),
    '--dbname', decodeURIComponent(parsed.pathname.slice(1))];
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) };
  for (const name of ['DATABASE_URL', 'REPLACEMENT_INSTRUCTOR_NAME', 'REPLACEMENT_INSTRUCTOR_USERNAME', 'REPLACEMENT_INSTRUCTOR_TEMP_PASSWORD']) delete env[name];
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  const result = spawnSync('pg_dump', args, { encoding: 'utf8', env, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Database backup failed (${result.error?.message || `pg_dump exited ${result.status}`}). Install PostgreSQL command-line tools and retry. No database changes were made.`);
  }
  if (statSync(backupPath).size === 0) throw new Error('Database backup file is empty. No database changes were made.');
  stdout.write(`Backup created: ${backupPath}\n`);
}

async function askForConfirmation(count) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Execution requires an interactive terminal so the impact summary can be confirmed. No database changes were made.');
  const phrase = `DELETE ${count} INSTRUCTOR ACCOUNTS`;
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(`\nType exactly “${phrase}” to create the replacement instructor and permanently remove the listed accounts: `);
    if (answer.trim() !== phrase) throw new Error('Confirmation did not match. No database changes were made.');
  } finally {
    terminal.close();
  }
}

async function main() {
  const preview = await pool.connect();
  let impact;
  let existingReplacement;
  try {
    impact = await readImpact(preview);
    if (execute) {
      existingReplacement = await preview.query('SELECT id, role FROM users WHERE username = $1', [replacementUsername]);
    }
  } finally {
    preview.release();
  }
  printImpact(impact, existingReplacement?.rowCount > 0);
  if (!execute) {
    stdout.write('\nDry run only. Set replacement account details and run with --execute to review this summary again and confirm the deletion.\n');
    return;
  }
  if (!impact.totals.instructors) throw new Error('No instructor accounts were found; nothing to remove.');
  if (existingReplacement?.rowCount) throw new Error(`The replacement username is already used by a ${existingReplacement.rows[0].role}. No database changes were made.`);
  await askForConfirmation(impact.totals.instructors);

  makeBackup();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users, courses, class_sessions, attendance IN SHARE ROW EXCLUSIVE MODE');
    const current = await readImpact(client);
    const fingerprint = value => createHash('sha256').update(JSON.stringify({
      instructors: value.instructors.map(item => [item.id, item.username, item.is_active, item.is_archived, item.course_count, item.session_count, item.attendance_count]),
      courses: value.courses.map(item => [item.id, item.code, item.instructor_name, item.instructor_id]), totals: value.totals,
    })).digest('hex');
    if (fingerprint(current) !== fingerprint(impact)) throw new Error('The affected data changed since the preview. No database records were changed; rerun the dry run.');
    const conflict = await client.query('SELECT id, role FROM users WHERE username = $1', [replacementUsername]);
    if (conflict.rowCount) throw new Error('The replacement username became unavailable. No database records were changed.');

    const instructorIds = current.instructors.map(item => item.id);
    const inserted = await client.query(`INSERT INTO users (name, username, password_hash, role, must_change_password, is_active, is_archived)
      VALUES ($1, $2, $3, 'instructor', 1, 1, 0) RETURNING id`, [replacementName, replacementUsername, hashPassword(replacementPassword)]);
    const replacementId = inserted.rows[0].id;
    await client.query(`ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS instructor_name_snapshot TEXT`);
    await client.query(`UPDATE class_sessions s SET instructor_name_snapshot = COALESCE(s.instructor_name_snapshot, u.name)
      FROM users u WHERE s.instructor_id = u.id AND u.role = 'instructor'`);
    await client.query('UPDATE courses SET instructor_id = $1 WHERE instructor_id = ANY($2::int[])', [replacementId, instructorIds]);
    await client.query('UPDATE class_sessions SET instructor_id = $1 WHERE instructor_id = ANY($2::int[])', [replacementId, instructorIds]);
    const deleted = await client.query("DELETE FROM users WHERE role = 'instructor' AND id <> $1", [replacementId]);
    await client.query('COMMIT');
    stdout.write(`\nMigration complete: created ${replacementName} (${replacementUsername}), reassigned ${current.totals.courses} courses, retained ${current.totals.sessions} sessions and ${current.totals.attendance} attendance rows, and removed ${deleted.rowCount} former instructor accounts.\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

try {
  await main();
} finally {
  await pool.end();
}
