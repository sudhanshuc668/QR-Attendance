import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = resolve(process.env.SQLITE_PATH || join(ROOT, 'attendance.db'));
const connectionString = process.env.DATABASE_URL;
const adminUsername = String(process.env.INITIAL_ADMIN_USERNAME || '').trim().toLowerCase();
const adminPassword = String(process.env.INITIAL_ADMIN_PASSWORD || '');
const demoUsernames = new Set(['admin', 'instructor', 'student1', 'student2', 'student3', 'student4', 'student5', 'student6']);

if (!connectionString) throw new Error('Set DATABASE_URL in the environment; do not put it in a file that will be committed.');
if (!/^[a-z0-9][a-z0-9._/-]{1,39}$/.test(adminUsername) || adminPassword.length < 12 || adminPassword.length > 128) {
  throw new Error('Set INITIAL_ADMIN_USERNAME and a 12–128 character INITIAL_ADMIN_PASSWORD in the environment.');
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
const pool = new pg.Pool({ connectionString });
const schema = readFileSync(join(ROOT, 'schema.postgres.sql'), 'utf8');

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function rows(table) { return source.prepare(`SELECT * FROM ${table}`).all(); }

function insertSql(table, fields) {
  const columns = fields.join(', ');
  const markers = fields.map((_, index) => `$${index + 1}`).join(', ');
  return `INSERT INTO ${table} (${columns}) VALUES (${markers})`;
}

async function migrate() {
  await pool.query(schema);
  const occupied = await pool.query(`SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM courses) AS courses,
    (SELECT COUNT(*) FROM enrollments) AS enrollments,
    (SELECT COUNT(*) FROM departments) AS departments,
    (SELECT COUNT(*) FROM student_profiles) AS profiles,
    (SELECT COUNT(*) FROM class_sessions) AS sessions,
    (SELECT COUNT(*) FROM attendance) AS attendance`);
  const nonDepartmentData = Object.entries(occupied.rows[0])
    .filter(([table]) => table !== 'departments')
    .some(([, value]) => Number(value) > 0);
  const existingDepartments = await pool.query('SELECT name, year_count FROM departments');
  const startupDepartments = ['BCA', 'BBA', 'B.Com', 'B.Sc'];
  const startupDepartmentNames = new Set(startupDepartments);
  const onlyRenderStartupDepartments = existingDepartments.rows.length === startupDepartments.length &&
    existingDepartments.rows.every((department, index) =>
      startupDepartmentNames.has(department.name) && Number(department.year_count) === 3);
  if (nonDepartmentData || (existingDepartments.rowCount && !onlyRenderStartupDepartments)) {
    throw new Error('Target database already contains attendance data. Migration stopped without changing it.');
  }

  const sourceUsers = rows('users');
  const keptUsers = sourceUsers.filter(user => !demoUsernames.has(user.username.toLowerCase()));
  const keptUserIds = new Set(keptUsers.map(user => user.id));
  const departments = rows('departments');
  const departmentIds = new Set(departments.map(department => department.id));
  const courses = rows('courses').filter(course => keptUserIds.has(course.instructor_id));
  const courseIds = new Set(courses.map(course => course.id));
  const enrollments = rows('enrollments').filter(item => courseIds.has(item.course_id) && keptUserIds.has(item.student_id));
  const profiles = rows('student_profiles').filter(item => keptUserIds.has(item.user_id) && departmentIds.has(item.department_id));
  const sessions = rows('class_sessions').filter(item => courseIds.has(item.course_id) && keptUserIds.has(item.instructor_id));
  const sessionIds = new Set(sessions.map(session => session.id));
  const attendance = rows('attendance').filter(item => sessionIds.has(item.session_id) && keptUserIds.has(item.student_id));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Render may have started the app before migration and inserted only its four
    // built-in departments. Remove those inside the import transaction so failed
    // migrations leave the target unchanged.
    if (onlyRenderStartupDepartments) {
      await client.query('DELETE FROM departments WHERE name = ANY($1::text[])', [startupDepartments]);
    }
    for (const item of keptUsers) {
      await client.query(insertSql('users', ['id', 'name', 'username', 'password_hash', 'role', 'must_change_password']),
        [item.id, item.name, item.username, item.password_hash, item.role, item.must_change_password ?? 0]);
    }
    for (const item of departments) {
      await client.query(insertSql('departments', ['id', 'name', 'year_count']), [item.id, item.name, item.year_count]);
    }
    for (const item of courses) {
      await client.query(insertSql('courses', ['id', 'name', 'code', 'instructor_id']), [item.id, item.name, item.code, item.instructor_id]);
    }
    for (const item of enrollments) {
      await client.query(insertSql('enrollments', ['course_id', 'student_id']), [item.course_id, item.student_id]);
    }
    for (const item of profiles) {
      await client.query(insertSql('student_profiles', ['user_id', 'department_id', 'year_number', 'updated_at']),
        [item.user_id, item.department_id, item.year_number, item.updated_at]);
    }
    for (const item of sessions) {
      await client.query(insertSql('class_sessions', ['id', 'course_id', 'instructor_id', 'started_at', 'ended_at']),
        [item.id, item.course_id, item.instructor_id, item.started_at, item.ended_at]);
    }
    for (const item of attendance) {
      await client.query(insertSql('attendance', ['id', 'session_id', 'student_id', 'method', 'marked_at']),
        [item.id, item.session_id, item.student_id, item.method, item.marked_at]);
    }

    const adminExists = await client.query('SELECT id FROM users WHERE username = $1', [adminUsername]);
    if (adminExists.rowCount) throw new Error('The chosen initial admin username already exists in the migrated data. Choose a different one.');
    await client.query(`INSERT INTO users (name, username, password_hash, role, must_change_password)
      VALUES ($1, $2, $3, 'admin', 1)`, [process.env.INITIAL_ADMIN_NAME || 'College Administrator', adminUsername, hashPassword(adminPassword)]);

    for (const table of ['users', 'departments', 'courses', 'class_sessions', 'attendance']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${table}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log(JSON.stringify({
    migrated: { users: keptUsers.length + 1, departments: departments.length, courses: courses.length, enrollments: enrollments.length, profiles: profiles.length, sessions: sessions.length, attendance: attendance.length },
    excludedSeedAccounts: sourceUsers.length - keptUsers.length,
    sourceDatabase: isAbsolute(sourcePath) ? 'local database file' : 'database file',
  }, null, 2));
}

migrate().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  source.close();
  await pool.end();
});
