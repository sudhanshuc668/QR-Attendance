const app = document.querySelector('#app');
const userSlot = document.querySelector('#topbar-user');
const toast = document.querySelector('#toast');
const params = new URLSearchParams(location.search);
const pendingCheckin = params.get('sessionId') && params.get('token')
  ? { sessionId: Number(params.get('sessionId')), token: params.get('token') }
  : null;
let activeUser = null;
let qrTimer = null;
let rosterRefreshTimer = null;
let toastTimer = null;
let departmentList = [];
let rosterFilters = { departmentId: '', yearNumber: '' };

const themeToggle = document.querySelector('#theme-toggle');
const savedTheme = localStorage.getItem('rollcall-theme');
document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';
themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  localStorage.setItem('rollcall-theme', isDark ? 'dark' : 'light');
  themeToggle.setAttribute('aria-pressed', String(isDark));
  themeToggle.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
  themeToggle.querySelector('[aria-hidden="true"]').textContent = isDark ? '☀' : '☾';
  themeToggle.querySelector('.theme-toggle-label').textContent = isDark ? 'Light mode' : 'Dark mode';
});

if (savedTheme === 'dark') {
  themeToggle.setAttribute('aria-pressed', 'true');
  themeToggle.setAttribute('aria-label', 'Switch to light mode');
  themeToggle.querySelector('[aria-hidden="true"]').textContent = '☀';
  themeToggle.querySelector('.theme-toggle-label').textContent = 'Light mode';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status})`);
  return result;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function setUser(user) {
  activeUser = user;
  userSlot.classList.toggle('hidden', !user);
  const roleLabel = user?.role === 'instructor' ? 'Instructor' : user?.role === 'admin' ? 'Admin' : 'Student';
  userSlot.innerHTML = user ? `<strong>${escapeHtml(user.name)}</strong><span> · ${roleLabel}</span><button id="account-security-button" type="button">Account security</button><button id="logout-button" type="button">Sign out</button>` : '';
  document.querySelector('#account-security-button')?.addEventListener('click', openAccountSecurity);
  document.querySelector('#logout-button')?.addEventListener('click', logout);
}

function dateLabel(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  return value ? new Intl.DateTimeFormat(undefined, options).format(new Date(value)) : '—';
}

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

function yearLabel(year) {
  const suffix = year === 1 ? 'st' : year === 2 ? 'nd' : year === 3 ? 'rd' : 'th';
  return `${year}${suffix} Year`;
}

function yearButtonLabel(year) {
  const names = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];
  return `${names[year - 1] || `${year}th`} Year`;
}

function presentTodaySummary(students) {
  const present = students.filter(student => Boolean(student.present_today)).length;
  return `${students.length} student${students.length === 1 ? '' : 's'} · ${present} present today · ${students.length - present} not yet marked`;
}

function groupStudentRows(students) {
  return students.map(student => `<tr><td><strong>${escapeHtml(student.name)}</strong><small class="admin-roll">${escapeHtml(student.roll_number)}</small></td><td>${escapeHtml(student.department_name || 'Not assigned')} · ${escapeHtml(yearLabel(student.year_number))}</td><td>${escapeHtml(student.course_codes || '—')}</td></tr>`).join('');
}

function populateYearButtons(target, department, onSelect) {
  target.innerHTML = Array.from({ length: department.year_count }, (_, index) => {
    const year = index + 1;
    return `<button class="year-button" type="button" data-group-year="${year}" aria-pressed="false">${yearButtonLabel(year)}</button>`;
  }).join('');
  target.classList.remove('hidden');
  target.querySelectorAll('[data-group-year]').forEach(button => button.addEventListener('click', () => {
    target.querySelectorAll('[data-group-year]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    onSelect(Number(button.dataset.groupYear));
  }));
}

function departmentOptions(selectedId = '') {
  return `<option value="">Choose department</option>${departmentList.map(department => `<option value="${department.id}" ${String(selectedId) === String(department.id) ? 'selected' : ''}>${escapeHtml(department.name)}</option>`).join('')}`;
}

function yearOptions(departmentId = '', selectedYear = '', prompt = 'All years') {
  const department = departmentList.find(item => String(item.id) === String(departmentId));
  const years = department ? department.year_count : Math.max(3, ...departmentList.map(item => item.year_count));
  return `<option value="">${escapeHtml(prompt)}</option>${Array.from({ length: years }, (_, index) => index + 1).map(year => `<option value="${year}" ${String(selectedYear) === String(year) ? 'selected' : ''}>${yearLabel(year)}</option>`).join('')}`;
}

function dailyAttendanceGraph(report) {
  const records = [
    { label: 'Yesterday', ...report.yesterday },
    { label: 'Today', ...report.today },
  ];
  const maxCount = Math.max(1, ...records.map(item => item.count));
  const change = report.today.count - report.yesterday.count;
  const changeLabel = change === 0 ? 'No change' : `${change > 0 ? '+' : ''}${change} vs yesterday`;
  return `<section class="panel daily-report" aria-labelledby="daily-report-title">
    <div class="panel-head"><div><div class="panel-label">Daily overview</div><h2 id="daily-report-title">Yesterday vs today</h2><p>Unique students with at least one check-in · India time</p></div><span class="daily-change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}">${escapeHtml(changeLabel)}</span></div>
    <div class="daily-chart" role="img" aria-label="${records.map(item => `${item.label}: ${item.count} students`).join(', ')}">
      ${records.map((item, index) => {
        const height = item.count ? Math.max(8, Math.round(item.count / maxCount * 100)) : 4;
        const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${item.date}T00:00:00Z`));
        return `<div class="daily-bar-group"><div class="daily-count">${item.count}</div><div class="daily-bar-track"><div class="daily-bar ${index === 1 ? 'today' : ''}" style="height:${height}%"></div></div><strong>${item.label}</strong><span>${escapeHtml(date)}</span></div>`;
      }).join('')}
    </div>
  </section>`;
}

function attendanceReportsSection(students, today, courses = [], sessions = [], departments = []) {
  const studentOptions = students.map(student => `<option value="${escapeHtml(student.name)} · ${escapeHtml(student.roll_number)}"></option>`).join('');
  return `<section class="panel attendance-reports" aria-labelledby="attendance-reports-title">
    <div class="panel-head"><div><div class="panel-label">Attendance</div><h2 id="attendance-reports-title">Attendance records</h2><p>Take attendance by course and session, or review check-ins by date or student. Dates and times use India time.</p></div></div>
    <div class="attendance-report-tabs" role="tablist" aria-label="Attendance report view">
      <button type="button" class="attendance-report-tab" data-attendance-mode="take" aria-pressed="false">Take attendance</button>
      <button type="button" class="attendance-report-tab" data-attendance-mode="date" aria-pressed="true">By date</button>
      <button type="button" class="attendance-report-tab" data-attendance-mode="student" aria-pressed="false">By student</button>
    </div>
    <div id="attendance-worklist-controls" class="report-filters hidden">
      <label><span>Course</span><select id="attendance-course-filter"><option value="">Choose a course</option>${courses.map(course => `<option value="${course.id}">${escapeHtml(course.code)} · ${escapeHtml(course.name)}</option>`).join('')}</select></label>
      <label><span>Session</span><select id="attendance-session-filter" disabled><option value="">Choose a course first</option></select></label>
      <label><span>Department</span><select id="attendance-department-filter"><option value="">All departments</option>${departments.map(department => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join('')}</select></label>
    </div>
    <div id="attendance-date-controls" class="attendance-report-controls"><label for="attendance-report-date">Attendance date</label><input id="attendance-report-date" type="date" value="${escapeHtml(today)}"></div>
    <div id="attendance-student-controls" class="attendance-report-controls hidden"><label for="attendance-report-student">Student</label><input id="attendance-report-student" type="search" list="attendance-report-student-options" placeholder="Type a name or roll number" autocomplete="off" aria-describedby="attendance-report-student-hint"><datalist id="attendance-report-student-options">${studentOptions}</datalist><small id="attendance-report-student-hint">Choose a student from the suggestions to view their attendance.</small></div>
    <div id="attendance-report-results" class="attendance-report-results"><div class="empty-list">Loading attendance records…</div></div>
  </section>`;
}

function indiaDateTimeLabel(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value)) : '—';
}

function indiaDateLabel(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00.000Z`)) : '—';
}

function attendanceRecordsTable(rows, includeStudent) {
  if (!rows.length) return '<div class="empty-list">No attendance was recorded for this selection.</div>';
  return `<div class="table-wrap"><table><thead><tr>${includeStudent ? '<th>Student</th>' : ''}<th>Course / session</th><th>Session started</th><th>Marked at</th><th>Method</th></tr></thead><tbody>${rows.map(row => `<tr>${includeStudent ? `<td><strong>${escapeHtml(row.student_name)}</strong><small class="admin-roll">${escapeHtml(row.roll_number)}${row.department_name ? ` · ${escapeHtml(row.department_name)}${row.year_number ? ` · ${escapeHtml(yearLabel(row.year_number))}` : ''}` : ''}</small></td>` : ''}<td><strong>${escapeHtml(row.course_code)}</strong><small class="admin-roll">${escapeHtml(row.course_name)} · Session ${row.session_id}</small></td><td>${escapeHtml(indiaDateTimeLabel(row.session_started_at))}</td><td>${escapeHtml(indiaDateTimeLabel(row.marked_at))}</td><td><span class="method-tag">${row.method === 'qr' ? 'QR scan' : 'Manual'}</span></td></tr>`).join('')}</tbody></table></div>`;
}

async function loadAttendanceByDate(date) {
  const results = document.querySelector('#attendance-report-results');
  if (!results || !date) return;
  results.innerHTML = '<div class="empty-list">Loading attendance records…</div>';
  try {
    const result = await api(`/api/reports/attendance/by-date?date=${encodeURIComponent(date)}`);
    results.innerHTML = `<div class="attendance-report-caption">${escapeHtml(indiaDateLabel(result.date))} · ${result.attendance.length} recorded check-in${result.attendance.length === 1 ? '' : 's'}</div>${attendanceRecordsTable(result.attendance, true)}`;
  } catch (error) { results.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`; }
}

async function loadAttendanceByStudent(studentId) {
  const results = document.querySelector('#attendance-report-results');
  if (!results) return;
  if (!studentId) {
    results.innerHTML = '<div class="empty-list">Choose a student to view their attendance dates.</div>';
    return;
  }
  results.innerHTML = '<div class="empty-list">Loading attendance history…</div>';
  try {
    const result = await api(`/api/reports/attendance/students/${encodeURIComponent(studentId)}`);
    if (!result.attendance.length) {
      results.innerHTML = `<div class="attendance-report-caption">${escapeHtml(result.student.name)} · ${escapeHtml(result.student.roll_number)}</div><div class="empty-list">No attendance has been recorded for this student.</div>`;
      return;
    }
    const groups = new Map();
    result.attendance.forEach(row => {
      if (!groups.has(row.attendance_date)) groups.set(row.attendance_date, []);
      groups.get(row.attendance_date).push(row);
    });
    results.innerHTML = `<div class="attendance-report-caption">${escapeHtml(result.student.name)} · ${escapeHtml(result.student.roll_number)} · ${result.attendance.length} recorded check-in${result.attendance.length === 1 ? '' : 's'}</div>${[...groups].map(([date, rows]) => `<section class="attendance-day"><div class="attendance-day-heading"><h3>${escapeHtml(indiaDateLabel(date))}</h3><span>${rows.length} session${rows.length === 1 ? '' : 's'}</span></div>${attendanceRecordsTable(rows, false)}</section>`).join('')}`;
  } catch (error) { results.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`; }
}

function bindAttendanceReports(today, students, worklist = {}) {
  const dateControls = document.querySelector('#attendance-date-controls');
  const studentControls = document.querySelector('#attendance-student-controls');
  const worklistControls = document.querySelector('#attendance-worklist-controls');
  const dateInput = document.querySelector('#attendance-report-date');
  const studentInput = document.querySelector('#attendance-report-student');
  const courseInput = document.querySelector('#attendance-course-filter');
  const sessionInput = document.querySelector('#attendance-session-filter');
  const departmentInput = document.querySelector('#attendance-department-filter');
  if (!dateControls || !studentControls || !worklistControls || !dateInput || !studentInput) return;
  let mode = 'date';
  document.querySelectorAll('[data-attendance-mode]').forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.attendanceMode;
    document.querySelectorAll('[data-attendance-mode]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
    dateControls.classList.toggle('hidden', mode !== 'date');
    studentControls.classList.toggle('hidden', mode !== 'student');
    worklistControls.classList.toggle('hidden', mode !== 'take');
    if (mode === 'date') loadAttendanceByDate(dateInput.value || today);
    else if (mode === 'student') showAttendanceStudentSelection(studentInput.value, students);
    else {
      if (!courseInput.value && worklist.courses?.length) courseInput.value = String(worklist.courses[0].id);
      updateAttendanceSessionOptions(worklist.sessions || []);
      loadAttendanceWorklist();
    }
  }));
  dateInput.addEventListener('change', () => loadAttendanceByDate(dateInput.value));
  studentInput.addEventListener('change', () => showAttendanceStudentSelection(studentInput.value, students));
  courseInput?.addEventListener('change', () => {
    updateAttendanceSessionOptions(worklist.sessions || []);
    if (mode === 'take') loadAttendanceWorklist();
  });
  sessionInput?.addEventListener('change', () => { if (mode === 'take') loadAttendanceWorklist(); });
  departmentInput?.addEventListener('change', () => { if (mode === 'take') loadAttendanceWorklist(); });
  loadAttendanceByDate(dateInput.value || today);
}

function updateAttendanceSessionOptions(sessions) {
  const courseInput = document.querySelector('#attendance-course-filter');
  const sessionInput = document.querySelector('#attendance-session-filter');
  if (!courseInput || !sessionInput) return;
  const courseId = courseInput.value;
  const matching = sessions.filter(session => String(session.course_id) === String(courseId));
  sessionInput.innerHTML = matching.length
    ? `<option value="">Choose a session</option>${matching.map(session => `<option value="${session.id}">Session ${session.id} · ${escapeHtml(dateLabel(session.started_at))}${session.ended_at ? ' · Ended' : ' · In progress'}${session.instructor_name ? ` · ${escapeHtml(session.instructor_name)}` : ''}</option>`).join('')}`
    : '<option value="">No sessions for this course yet</option>';
  sessionInput.disabled = matching.length === 0;
}

async function loadAttendanceWorklist() {
  const results = document.querySelector('#attendance-report-results');
  const courseId = document.querySelector('#attendance-course-filter')?.value;
  const sessionId = document.querySelector('#attendance-session-filter')?.value;
  const departmentId = document.querySelector('#attendance-department-filter')?.value;
  if (!results) return;
  if (!courseId || !sessionId) {
    results.innerHTML = '<div class="empty-list">Choose a course and session to view enrolled students.</div>';
    return;
  }
  results.innerHTML = '<div class="empty-list">Loading enrolled students…</div>';
  const query = new URLSearchParams({ courseId });
  if (departmentId) query.set('departmentId', departmentId);
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/attendance?${query}`);
    const rows = result.roster.map(row => `<tr><td><strong>${escapeHtml(row.name)}</strong><small class="admin-roll">${escapeHtml(row.username)}</small></td><td>${escapeHtml(row.department_name || 'Not assigned')}${row.year_number ? ` · ${escapeHtml(yearLabel(row.year_number))}` : ''}</td><td><span class="status ${row.present ? 'status-present' : 'status-absent'}">${row.present ? 'Present' : 'Absent'}</span></td><td>${row.present ? `<span class="method-tag">${row.method === 'qr' ? 'QR scan' : 'Manual'} · ${escapeHtml(indiaDateTimeLabel(row.marked_at))}</span>` : `<button class="small-link" type="button" data-worklist-mark="${row.student_id}">Mark present</button>`}</td></tr>`).join('');
    results.innerHTML = `<div class="attendance-report-caption">${escapeHtml(result.session.course_code)} · ${escapeHtml(result.session.course_name)} · Session ${result.session.id} · ${result.roster.length} student${result.roster.length === 1 ? '' : 's'}</div>${result.roster.length ? `<div class="table-wrap"><table><thead><tr><th>Student / roll number</th><th>Department / year</th><th>Status</th><th>Attendance</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-list">No students are enrolled in this course for the selected department.</div>'}`;
    results.querySelectorAll('[data-worklist-mark]').forEach(button => button.addEventListener('click', () => markManual(Number(sessionId), Number(button.dataset.worklistMark), loadAttendanceWorklist)));
  } catch (error) {
    results.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`;
  }
}

function showAttendanceStudentSelection(value, students) {
  const query = value.trim().toLocaleLowerCase();
  const student = students.find(item => `${item.name} · ${item.roll_number}`.trim().toLocaleLowerCase() === query);
  if (student) {
    loadAttendanceByStudent(student.id);
    return;
  }
  const results = document.querySelector('#attendance-report-results');
  if (!results) return;
  results.innerHTML = query
    ? '<div class="empty-list">Choose a student from the suggestions to view their attendance.</div>'
    : '<div class="empty-list">Type a name or roll number to find a student.</div>';
}

async function bootstrap() {
  const authLink = new URLSearchParams(location.hash.slice(1));
  const resetToken = authLink.get('reset-password');
  const verifyToken = authLink.get('verify-email');
  if (resetToken) {
    return renderPasswordReset(resetToken);
  }
  if (verifyToken) {
    try {
      const result = await api('/api/recovery-email/verify', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });
      history.replaceState({}, '', `${location.pathname}${location.search}`);
      return renderLogin('', result.message);
    } catch (error) {
      return renderLogin(error.message);
    }
  }
  try {
    const result = await api('/api/me');
    setUser(result.user);
    await renderDashboard();
  } catch {
    setUser(null);
    renderLogin();
  }
}

function renderLogin(errorMessage = '', infoMessage = '') {
  clearInterval(qrTimer);
  clearInterval(rosterRefreshTimer);
  app.innerHTML = `
    <section class="login-wrap">
      <div class="hero-copy">
        <div class="eyebrow">Simple, smart attendance</div>
        <h1>Every class.<br>Counted.</h1>
        <p>Skip the paper sheet. Start a class, share a live QR code, and see attendance take shape in real time.</p>
        <div class="hero-note"><span class="hero-note-icon">✓</span><span>Rotating codes help keep each check-in current.</span></div>
      </div>
      <section class="login-card">
        <div class="panel-label">Welcome back</div>
        <h2>Sign in to RollCall</h2>
        <p class="subheading">Sign in with your college account to continue.</p>
        <form id="login-form">
          <div class="field"><label for="username">Username or roll number</label><input id="username" name="username" autocomplete="username" placeholder="Enter username or roll number" required></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required></div>
          ${errorMessage ? `<div class="login-error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
          ${infoMessage ? `<div class="recovery-info" role="status">${escapeHtml(infoMessage)}</div>` : ''}
          <button class="btn btn-primary btn-block" type="submit">Sign in <span aria-hidden="true">→</span></button>
        </form>
        <button id="forgot-password-link" class="small-link forgot-password-link" type="button">Forgot password?</button>
      </section>
    </section>`;
  document.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
      setUser(result.user);
      await renderDashboard();
    } catch (error) {
      renderLogin(error.message);
    }
  });
  document.querySelector('#forgot-password-link').addEventListener('click', renderForgotPassword);
  if (pendingCheckin) {
    const username = document.querySelector('#username');
    username.setAttribute('aria-describedby', 'checkin-hint');
    username.insertAdjacentHTML('afterend', '<small id="checkin-hint" style="display:block;color:#647693;margin-top:7px;font-size:11px">Sign in to record attendance for the scanned class. Check-in will complete automatically.</small>');
  }
}

function renderForgotPassword(errorMessage = '', infoMessage = '') {
  clearInterval(qrTimer);
  clearInterval(rosterRefreshTimer);
  app.innerHTML = `<section class="login-card recovery-card"><div class="panel-label">Account recovery</div><h2>Forgot password?</h2><p class="subheading">Submit a request for admin review. A reset link is sent to your verified recovery email after approval.</p>
    <form id="forgot-password-form"><div class="field"><label for="recovery-account-type">Account type</label><select id="recovery-account-type" name="accountType"><option value="student">Student</option><option value="instructor">Instructor</option></select></div>
      <div class="field"><label for="recovery-username">Username</label><input id="recovery-username" name="username" maxlength="40" autocomplete="username" required></div>
      <div id="recovery-roll-field" class="field"><label for="recovery-roll-number">Roll number</label><input id="recovery-roll-number" name="rollNumber" maxlength="40" autocomplete="off" required><small>Student username and roll number are the same in this app.</small></div>
      <div class="recovery-note">If you have not verified a recovery email, contact your administrator to set one up.</div>
      ${errorMessage ? `<div class="login-error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}${infoMessage ? `<div class="recovery-info" role="status">${escapeHtml(infoMessage)}</div>` : ''}
      <button class="btn btn-primary btn-block" type="submit">Submit reset request</button>
    </form><button id="back-to-login" class="small-link forgot-password-link" type="button">Back to sign in</button></section>`;
  const form = document.querySelector('#forgot-password-form');
  const type = document.querySelector('#recovery-account-type');
  const rollField = document.querySelector('#recovery-roll-field');
  type.addEventListener('change', () => {
    const isStudent = type.value === 'student';
    rollField.classList.toggle('hidden', !isStudent);
    rollField.querySelector('input').required = isStudent;
  });
  document.querySelector('#back-to-login').addEventListener('click', () => renderLogin());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api('/api/password-reset/request', { method: 'POST', body: JSON.stringify({
        accountType: data.get('accountType'), username: data.get('username'), rollNumber: data.get('rollNumber'),
      }) });
      renderForgotPassword('', result.message);
    } catch (error) {
      renderForgotPassword(error.message);
    }
  });
}

function renderPasswordReset(token, errorMessage = '') {
  app.innerHTML = `<section class="login-card password-change-card"><div class="panel-label">Account recovery</div><h2>Choose a new password</h2><p class="subheading">This reset link can be used once and expires one hour after it was issued.</p><form id="password-reset-form"><div class="field"><label for="reset-new-password">New password</label><input id="reset-new-password" name="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></div><div class="field"><label for="reset-confirm-password">Confirm new password</label><input id="reset-confirm-password" name="confirmPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></div>${errorMessage ? `<div class="login-error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}<button class="btn btn-primary btn-block" type="submit">Reset password</button></form></section>`;
  document.querySelector('#password-reset-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get('newPassword') || '');
    if (newPassword !== String(form.get('confirmPassword') || '')) return renderPasswordReset(token, 'The new password and confirmation do not match.');
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api('/api/password-reset/complete', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
      history.replaceState({}, '', `${location.pathname}${location.search}`);
      renderLogin('', result.message);
    } catch (error) {
      renderPasswordReset(token, error.message);
    }
  });
}

async function logout() {
  clearInterval(qrTimer);
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  setUser(null);
  renderLogin();
}

async function openAccountSecurity() {
  try {
    const status = await api('/api/me/recovery-email');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<section class="modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="account-security-title"><div class="panel-label">Account security</div><h2 id="account-security-title">Recovery email</h2><p>Your address is used only after you confirm it. ${status.verified ? `Verified address: <strong>${escapeHtml(status.email)}</strong>.` : 'No verified recovery email is set yet.'}</p><form id="recovery-email-form"><div class="field"><label for="recovery-email-input">Email address</label><input id="recovery-email-input" name="email" type="email" maxlength="254" autocomplete="email" value="${escapeHtml(status.email)}" required></div><div id="recovery-email-result" aria-live="polite"></div><div class="modal-actions"><button class="btn btn-outline" type="button" data-close-recovery>Close</button><button class="btn btn-primary" type="submit">Send verification link</button></div></form></section>`;
    document.body.append(backdrop);
    backdrop.querySelector('[data-close-recovery]').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', event => { if (event.target === backdrop) backdrop.remove(); });
    backdrop.querySelector('#recovery-email-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const submit = event.currentTarget.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const result = await api('/api/me/recovery-email', { method: 'POST', body: JSON.stringify({ email: form.get('email') }) });
        backdrop.querySelector('#recovery-email-result').innerHTML = `<div class="recovery-info" role="status">${escapeHtml(result.message)}</div>`;
      } catch (error) {
        backdrop.querySelector('#recovery-email-result').innerHTML = `<div class="login-error" role="alert">${escapeHtml(error.message)}</div>`;
      } finally {
        submit.disabled = false;
      }
    });
  } catch (error) { showToast(error.message, true); }
}

async function renderDashboard() {
  if (activeUser.mustChangePassword) return renderPasswordChange();
  if (activeUser.role === 'instructor') return renderInstructor();
  if (activeUser.role === 'admin') return renderAdmin();
  return renderStudent();
}

function renderPasswordChange(errorMessage = '') {
  app.innerHTML = `<section class="login-card password-change-card"><div class="panel-label">Account security</div><h2>Set your new password</h2><p class="subheading">Your admin-issued temporary password must be changed before you continue.</p><form id="password-change-form"><div class="field"><label for="current-password">Temporary password</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="new-password">New password</label><input id="new-password" name="newPassword" type="password" minlength="8" autocomplete="new-password" required></div><div class="field"><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></div>${errorMessage ? `<div class="login-error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}<button class="btn btn-primary btn-block" type="submit">Save new password</button></form></section>`;
  document.querySelector('#password-change-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get('newPassword') || '');
    if (newPassword !== String(form.get('confirmPassword') || '')) return renderPasswordChange('The new password and confirmation do not match.');
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword }) });
      setUser(result.user);
      showToast('Password changed. Welcome to RollCall.');
      await renderDashboard();
    } catch (error) { renderPasswordChange(error.message); }
  });
}

async function renderAdmin() {
  clearInterval(qrTimer);
  clearInterval(rosterRefreshTimer);
  app.innerHTML = '<div class="loading-card">Loading admin dashboard…</div>';
  try {
    const [courseResult, instructorResult, departmentResult, studentResult, report, sessionResult, recoveryAccounts, resetRequests] = await Promise.all([
      api('/api/admin/courses'), api('/api/admin/instructors'), api('/api/departments'), api('/api/admin/students'), api('/api/reports/daily-attendance'), api('/api/admin/sessions'), api('/api/admin/recovery-accounts'), api('/api/admin/password-reset-requests'),
    ]);
    const courses = courseResult.courses;
    const instructors = instructorResult.instructors;
    const inactiveInstructors = instructorResult.inactiveInstructors || [];
    const archivedInstructors = instructorResult.archivedInstructors || [];
    departmentList = departmentResult.departments;
    app.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Administration</div><h1>Welcome, ${escapeHtml(activeUser.name.split(' ')[0])}</h1><p>Add students and review attendance activity.</p></div><div class="date-chip">${escapeHtml(new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(new Date()))}</div></div>
      ${dailyAttendanceGraph(report)}
      ${attendanceReportsSection(studentResult.students, report.today.date, courses, sessionResult.sessions, departmentList)}
      <section class="panel instructor-management-panel"><div class="panel-head"><div><div class="panel-label">Teaching staff</div><h2>Instructors &amp; courses</h2><p>Add instructor accounts and assign each course to its class teacher.</p></div></div>
        <div class="instructor-management-grid">
          <form id="add-instructor-form" class="admin-student-form instructor-create-form">
            <div class="field"><label for="instructor-name">Instructor name</label><input id="instructor-name" name="name" maxlength="100" autocomplete="name" required></div>
            <div class="field"><label for="instructor-username">Username</label><input id="instructor-username" name="username" maxlength="40" autocomplete="off" required></div>
            <div class="field"><label for="instructor-temp-password">Temporary password</label><input id="instructor-temp-password" name="temporaryPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required><small>Instructor must change this at first sign-in.</small></div>
            <button class="btn btn-primary" type="submit">＋ Add instructor</button>
          </form>
          <div><div id="admin-instructor-directory" class="instructor-directory">${renderInstructorDirectory(instructors, courses)}</div>
          <div class="inactive-instructor-section"><div class="panel-label">Inactive instructors</div><div id="admin-inactive-instructors" class="instructor-directory">${renderInstructorRecoveryDirectory(inactiveInstructors, courses, instructors, 'inactive')}</div></div>
          <div class="inactive-instructor-section"><div class="panel-label">Archived instructors</div><p class="instructor-archive-note">Accounts are blocked from sign-in. Courses and history are retained; reassign courses or restore an account here.</p><div id="admin-archived-instructors" class="instructor-directory">${renderInstructorRecoveryDirectory(archivedInstructors, courses, instructors, 'archived')}</div></div></div>
        </div>
        <form id="admin-manage-course-form" class="course-create-form"><h3>Assign a course to an instructor</h3>
          <div class="course-create-fields"><div class="field"><label for="admin-manage-course-name">Course name</label><input id="admin-manage-course-name" name="name" maxlength="100" required></div><div class="field"><label for="admin-manage-course-code">Course code</label><input id="admin-manage-course-code" name="code" maxlength="20" required></div><div class="field"><label for="admin-manage-course-instructor">Class teacher</label><select id="admin-manage-course-instructor" name="instructorId" required><option value="">Choose instructor</option>${instructors.map(item => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.username)}</option>`).join('')}</select></div></div>
          <button class="btn btn-outline" type="submit">＋ Create and assign course</button>
        </form>
      </section>
      <section class="panel account-recovery-panel"><div class="panel-head"><div><div class="panel-label">Account security</div><h2>Password recovery</h2><p>Verify the requester’s identity through your college process before approving a reset.</p></div></div>
        <div class="reset-request-list">${resetRequests.requests.length ? resetRequests.requests.map(request => `<article class="reset-request-row"><div><strong>${escapeHtml(request.name)}</strong><small>${escapeHtml(request.role)} · ${escapeHtml(request.username)}${request.role === 'student' ? ' (roll number)' : ''} · ${escapeHtml(request.recovery_email)}</small><small>Requested ${escapeHtml(dateLabel(request.requested_at))}</small></div><div class="reset-request-actions"><button class="btn btn-outline" type="button" data-reject-reset="${request.id}">Reject</button><button class="btn btn-primary" type="button" data-approve-reset="${request.id}">Approve and email link</button></div></article>`).join('') : '<div class="empty-list">No password reset requests are waiting for review.</div>'}</div>
        <form id="admin-recovery-email-form" class="admin-recovery-email-form"><h3>Set up a recovery email for an existing account</h3><p>Confirm the person’s identity before sending an email verification link.</p><div class="course-create-fields"><div class="field"><label for="recovery-account-select">Student or instructor</label><select id="recovery-account-select" name="userId" required><option value="">Choose account</option>${recoveryAccounts.accounts.map(account => `<option value="${account.id}">${escapeHtml(account.name)} · ${escapeHtml(account.role)} · ${escapeHtml(account.username)}${account.recovery_email_verified_at ? ' · email verified' : ''}</option>`).join('')}</select></div><div class="field"><label for="admin-recovery-email">Email address</label><input id="admin-recovery-email" name="email" type="email" maxlength="254" autocomplete="off" required></div></div><button class="btn btn-outline" type="submit">Send verification link</button></form>
      </section>
      <div class="admin-student-grid">
        <section class="panel"><div class="panel-head"><div><div class="panel-label">New account</div><h2>Add a student</h2><p>Create an account and assign the academic group and course.</p></div></div>
          <form id="add-student-form" class="admin-student-form">
            <div class="field"><label for="student-name">Student name</label><input id="student-name" name="name" maxlength="100" autocomplete="name" required></div>
            <div class="field"><label for="student-roll">Roll number (login username)</label><input id="student-roll" name="rollNumber" maxlength="40" autocomplete="off" required></div>
            <div class="field"><label for="student-temp-password">Temporary password</label><input id="student-temp-password" name="temporaryPassword" type="password" minlength="8" autocomplete="new-password" required><small>Student must change this at first sign-in.</small></div>
            <div class="field"><label for="student-department">Department</label><select id="student-department" name="departmentId" required>${departmentOptions()}</select></div>
            <div class="field"><label for="student-year">Year</label><select id="student-year" name="yearNumber" required>${yearOptions('', '', 'Choose year')}</select></div>
            <div class="field"><label for="student-course">Course</label><select id="student-course" name="courseId" required><option value="">Choose course</option>${courses.filter(course => Number(course.instructor_is_active) && !Number(course.instructor_is_archived)).map(course => `<option value="${course.id}">${escapeHtml(course.code)} · ${escapeHtml(course.name)}</option>`).join('')}</select><button class="course-add-trigger" type="button" data-course-form-target="admin-add-course-form">＋ Add a new course</button></div>
            <button class="btn btn-primary" type="submit">＋ Add student</button>
          </form>
          <form id="admin-add-course-form" class="course-create-form hidden">
            <h3>Add a new course</h3>
            <div class="course-create-fields"><div class="field"><label for="admin-course-name">Course name</label><input id="admin-course-name" name="name" maxlength="100" required></div><div class="field"><label for="admin-course-code">Course code</label><input id="admin-course-code" name="code" maxlength="20" required></div><div class="field"><label for="admin-course-instructor">Instructor</label><select id="admin-course-instructor" name="instructorId" required><option value="">Choose instructor</option>${instructors.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></div></div>
            <button class="btn btn-outline" type="submit">＋ Create course</button>
          </form>
        </section>
        <section class="panel admin-student-list"><div class="panel-head"><div><div class="panel-label">Student accounts</div><h2>Manage students</h2><p>Choose a department, then a year to view that student group.</p></div></div>
          ${studentResult.students.length ? `<div class="department-browser"><div class="department-grid">${departmentList.map(department => `<button class="department-chip department-button" type="button" data-admin-department="${department.id}" aria-pressed="false"><span class="department-symbol">${escapeHtml(initials(department.name))}</span><span><strong>${escapeHtml(department.name)}</strong><small>${department.year_count} year groups</small></span></button>`).join('')}</div><div id="admin-year-buttons" class="year-button-row hidden"></div><div id="admin-group-summary" class="group-summary">All students · ${presentTodaySummary(studentResult.students)}</div></div><span id="admin-student-count" class="hidden">${studentResult.students.length}</span><div class="table-wrap"><table><thead><tr><th>Student / roll number</th><th>Department / year</th><th>Course</th><th></th></tr></thead><tbody>${studentResult.students.map(student => `<tr data-admin-student-row data-department-id="${student.department_id ?? ''}" data-year-number="${student.year_number ?? ''}" data-present-today="${student.present_today ? 'true' : 'false'}"><td><strong>${escapeHtml(student.name)}</strong><small class="admin-roll">${escapeHtml(student.roll_number)}</small></td><td>${escapeHtml(student.department_name || 'Not assigned')}${student.year_number ? ` · ${escapeHtml(yearLabel(student.year_number))}` : ''}</td><td>${escapeHtml(student.course_codes || '—')}</td><td><button class="small-link" type="button" data-change-student-group="${student.id}" ${departmentList.length ? '' : 'disabled'}>Change group</button></td></tr>`).join('')}</tbody></table></div><div id="admin-student-empty" class="empty-list hidden">No students match this department and year.</div>` : '<div class="empty-list">No student accounts yet. Add the first student using the form.</div>'}
        </section>
      </div>
      <section class="panel admin-department-management"><div class="panel-head"><div><div class="panel-label">Academic setup</div><h2>Manage departments</h2><p>Deleting a department unassigns its students from their department and year. Student accounts and attendance remain.</p></div></div>
        ${departmentList.length ? `<div class="admin-department-list">${departmentList.map(department => `<article class="admin-department-row"><div><strong>${escapeHtml(department.name)}</strong><small>${department.year_count} year groups · ${department.student_count} student${Number(department.student_count) === 1 ? '' : 's'}</small></div><button class="btn btn-outline btn-delete-department" type="button" data-delete-department="${department.id}">Delete</button></article>`).join('')}</div>` : '<div class="empty-list">No departments to manage.</div>'}
      </section>`;
    document.querySelector('#student-department').addEventListener('change', event => {
      document.querySelector('#student-year').innerHTML = yearOptions(event.target.value, '', 'Choose year');
    });
    setupAdminDepartmentBrowser(studentResult.students);
    bindAttendanceReports(report.today.date, studentResult.students, { courses, sessions: sessionResult.sessions });
    bindAddCourseForm('admin-add-course-form', 'student-course', { onCreated: refreshAdminInstructorDirectory });
    bindAddCourseForm('admin-manage-course-form', null, { onCreated: refreshAdminInstructorDirectory });
    document.querySelector('#add-instructor-form').addEventListener('submit', addInstructor);
    setupAdminPasswordRecovery(resetRequests.requests, recoveryAccounts.accounts);
    setupAdminInstructorActions(inactiveInstructors, archivedInstructors, courses, instructors);
    document.querySelector('#add-student-form').addEventListener('submit', addStudent);
    setupAdminDepartmentManagement(departmentList);
    setupAdminStudentGroupEditor(studentResult.students);
  } catch (error) { app.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`; }
}

function setupAdminPasswordRecovery(requests, accounts) {
  document.querySelectorAll('[data-approve-reset]').forEach(button => button.addEventListener('click', async () => {
    const request = requests.find(item => String(item.id) === button.dataset.approveReset);
    if (!request) return;
    const confirmed = await confirmDialog('Approve password reset?', `Confirm the person’s identity before sending a one-time reset link to ${request.recovery_email}. The link expires in one hour.`, 'Approve and send link', 'Cancel');
    if (!confirmed) return;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/password-reset-requests/${request.id}/approve`, { method: 'POST', body: '{}' });
      showToast(result.message);
      await renderAdmin();
    } catch (error) { button.disabled = false; showToast(error.message, true); }
  }));
  document.querySelectorAll('[data-reject-reset]').forEach(button => button.addEventListener('click', async () => {
    const request = requests.find(item => String(item.id) === button.dataset.rejectReset);
    if (!request) return;
    const confirmed = await confirmDialog('Reject reset request?', `No password reset email will be sent for ${request.name}.`, 'Reject request', 'Cancel');
    if (!confirmed) return;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/password-reset-requests/${request.id}/reject`, { method: 'POST', body: '{}' });
      showToast(result.message);
      await renderAdmin();
    } catch (error) { button.disabled = false; showToast(error.message, true); }
  }));
  const form = document.querySelector('#admin-recovery-email-form');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const account = accounts.find(item => String(item.id) === String(data.get('userId')));
    if (!account) return;
    const confirmed = await confirmDialog('Send email verification link?', `Only continue after confirming ${account.name}’s identity through the college’s normal process. A link will be sent to the address entered below.`, 'Send verification link', 'Cancel');
    if (!confirmed) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api(`/api/admin/users/${account.id}/recovery-email`, { method: 'POST', body: JSON.stringify({ email: data.get('email') }) });
      showToast(result.message);
      form.reset();
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
  });
}

function setupAdminDepartmentManagement(departments) {
  document.querySelectorAll('[data-delete-department]').forEach(button => button.addEventListener('click', async () => {
    const department = departments.find(item => String(item.id) === button.dataset.deleteDepartment);
    if (!department) return;
    const studentCount = Number(department.student_count) || 0;
    const studentImpact = studentCount
      ? `${studentCount} student${studentCount === 1 ? '' : 's'} will lose their department and year assignment. Their accounts, enrollments, and attendance will remain.`
      : 'No students are assigned to this department.';
    const confirmed = await confirmDialog(`Delete ${department.name}?`, `${studentImpact} This action cannot be undone.`, 'Delete department', 'Cancel');
    if (!confirmed) return;
    button.disabled = true;
    try {
      await api(`/api/departments/${department.id}`, { method: 'DELETE' });
      showToast(`${department.name} was deleted.`);
      await renderAdmin();
    } catch (error) {
      button.disabled = false;
      showToast(error.message, true);
    }
  }));
}

function setupAdminDepartmentBrowser(students) {
  if (!students.length) return;
  const yearButtons = document.querySelector('#admin-year-buttons');
  const summary = document.querySelector('#admin-group-summary');
  const rows = [...document.querySelectorAll('[data-admin-student-row]')];
  const empty = document.querySelector('#admin-student-empty');
  const showGroup = (department, year) => {
    const filtered = students.filter(student => String(student.department_id) === String(department.id) && Number(student.year_number) === year);
    rows.forEach(row => { row.hidden = row.dataset.departmentId !== String(department.id) || Number(row.dataset.yearNumber) !== year; });
    summary.textContent = `${department.name} · ${yearButtonLabel(year)} · ${presentTodaySummary(filtered)}`;
    empty.classList.toggle('hidden', filtered.length > 0);
  };
  document.querySelectorAll('[data-admin-department]').forEach(button => button.addEventListener('click', () => {
    const department = departmentList.find(item => String(item.id) === button.dataset.adminDepartment);
    document.querySelectorAll('[data-admin-department]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    rows.forEach(row => { row.hidden = true; });
    empty.classList.add('hidden');
    summary.textContent = `${department.name} · Choose a year group.`;
    populateYearButtons(yearButtons, department, year => showGroup(department, year));
  }));
}

function setupInstructorDepartmentBrowser(students) {
  const yearButtons = document.querySelector('#instructor-year-buttons');
  const summary = document.querySelector('#instructor-group-summary');
  const results = document.querySelector('#instructor-group-results');
  document.querySelectorAll('[data-instructor-department]').forEach(button => button.addEventListener('click', () => {
    const department = departmentList.find(item => String(item.id) === button.dataset.instructorDepartment);
    document.querySelectorAll('[data-instructor-department]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    results.classList.add('hidden');
    summary.textContent = `${department.name} · Choose a year group.`;
    populateYearButtons(yearButtons, department, year => {
      const filtered = students.filter(student => String(student.department_id) === String(department.id) && Number(student.year_number) === year);
      summary.textContent = `${department.name} · ${yearButtonLabel(year)} · ${presentTodaySummary(filtered)}`;
      results.innerHTML = filtered.length
        ? `<table><thead><tr><th>Student / roll number</th><th>Department / year</th><th>Course</th></tr></thead><tbody>${groupStudentRows(filtered)}</tbody></table>`
        : '<div class="empty-list">No students are assigned to this year group yet.</div>';
      results.classList.remove('hidden');
    });
  }));
}

function setupAdminStudentGroupEditor(students) {
  document.querySelectorAll('[data-change-student-group]').forEach(button => button.addEventListener('click', () => {
    const student = students.find(item => String(item.id) === button.dataset.changeStudentGroup);
    if (!student) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="student-group-dialog-title">
      <h2 id="student-group-dialog-title">Change student group</h2>
      <p>Update ${escapeHtml(student.name)}’s department and year. Current course enrollment and attendance will stay unchanged.</p>
      <form id="admin-student-group-form">
        <div class="field"><label for="edit-student-department">Department</label><select id="edit-student-department" name="departmentId" required>${departmentOptions(student.department_id ?? '')}</select></div>
        <div class="field"><label for="edit-student-year">Year</label><select id="edit-student-year" name="yearNumber" ${student.department_id ? '' : 'disabled'} required>${yearOptions(student.department_id ?? '', student.year_number ?? '', student.department_id ? 'Choose year' : 'Choose department first')}</select></div>
        <div class="modal-actions"><button class="btn btn-outline" type="button" data-cancel-group-edit>Cancel</button><button class="btn btn-primary" type="submit">Save group</button></div>
      </form>
    </section>`;
    document.body.append(backdrop);
    const departmentInput = backdrop.querySelector('#edit-student-department');
    const yearInput = backdrop.querySelector('#edit-student-year');
    departmentInput.addEventListener('change', () => {
      yearInput.innerHTML = yearOptions(departmentInput.value, '', departmentInput.value ? 'Choose year' : 'Choose department first');
      yearInput.disabled = !departmentInput.value;
    });
    backdrop.querySelector('[data-cancel-group-edit]').addEventListener('click', () => backdrop.remove());
    backdrop.querySelector('#admin-student-group-form').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('[type="submit"]');
      const form = new FormData(event.currentTarget);
      submit.disabled = true;
      try {
        await api(`/api/admin/students/${student.id}/group`, { method: 'POST', body: JSON.stringify({
          departmentId: Number(form.get('departmentId')), yearNumber: Number(form.get('yearNumber')),
        }) });
        backdrop.remove();
        showToast(`${student.name}’s department and year were updated.`);
        await renderAdmin();
      } catch (error) {
        submit.disabled = false;
        showToast(error.message, true);
      }
    });
    backdrop.querySelector('#edit-student-department').focus();
  }));
}

async function addStudent(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = formElement.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const payload = {
      name: form.get('name'), rollNumber: form.get('rollNumber'), temporaryPassword: form.get('temporaryPassword'),
      departmentId: Number(form.get('departmentId')), yearNumber: Number(form.get('yearNumber')),
      courseId: Number(form.get('courseId')),
    };
    const result = await api('/api/admin/students', { method: 'POST', body: JSON.stringify(payload) });
    showToast(`${result.student.name} was added. Username: ${result.student.rollNumber}`);
    await renderAdmin();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
}

async function addInstructorStudent(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = formElement.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/instructor/students', { method: 'POST', body: JSON.stringify({
      name: form.get('name'), rollNumber: form.get('rollNumber'), temporaryPassword: form.get('temporaryPassword'),
      departmentId: Number(form.get('departmentId')), yearNumber: Number(form.get('yearNumber')), courseId: Number(form.get('courseId')),
    }) });
    showToast(`${result.student.name} was added. Username: ${result.student.rollNumber}`);
    await renderInstructor();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderInstructorDirectory(instructors, courses) {
  if (!instructors.length) return '<div class="empty-list">No active instructors. Add an instructor account or restore one below.</div>';
  return `<div class="instructor-directory-heading">${instructors.length} instructor${instructors.length === 1 ? '' : 's'}</div>${instructors.map(instructor => {
    const assigned = courses.filter(course => Number(course.instructor_id) === Number(instructor.id));
    return `<article class="instructor-directory-card"><div class="instructor-directory-person"><strong>${escapeHtml(instructor.name)}</strong><span>@${escapeHtml(instructor.username || '')}</span></div><div class="instructor-course-list">${assigned.length ? assigned.map(course => `<span class="instructor-course-chip"><strong>${escapeHtml(course.code)}</strong> · ${escapeHtml(course.name)}</span>`).join('') : '<span class="instructor-unassigned">No courses assigned yet</span>'}</div><div class="instructor-actions"><button class="btn btn-outline" type="button" data-show-instructor-password-form="${instructor.id}">Reset password</button><button class="btn btn-outline instructor-deactivate" type="button" data-deactivate-instructor="${instructor.id}">Deactivate</button><button class="btn btn-outline instructor-archive" type="button" data-archive-instructor="${instructor.id}">Delete</button></div><form class="admin-instructor-password-form hidden" data-instructor-password-form="${instructor.id}"><label class="field"><span>New temporary password</span><input type="password" name="temporaryPassword" minlength="8" maxlength="128" autocomplete="new-password" required></label><label class="field"><span>Confirm temporary password</span><input type="password" name="confirmPassword" minlength="8" maxlength="128" autocomplete="new-password" required></label><p class="instructor-archive-note">The instructor must choose a new password at next sign-in. Existing sessions and reset links will be invalidated.</p><div class="instructor-actions"><button class="btn btn-primary" type="submit">Set temporary password</button><button class="btn btn-outline" type="button" data-cancel-instructor-password="${instructor.id}">Cancel</button></div></form></article>`;
  }).join('')}`;
}

function renderInstructorRecoveryDirectory(instructors, courses, activeInstructors, statusLabel) {
  if (!instructors.length) return `<div class="instructor-unassigned">No ${escapeHtml(statusLabel)} instructors.</div>`;
  return instructors.map(instructor => {
    const assigned = courses.filter(course => Number(course.instructor_id) === Number(instructor.id));
    const assignments = assigned.length ? assigned.map(course => `<div class="inactive-course-row"><span><strong>${escapeHtml(course.code)}</strong> · ${escapeHtml(course.name)}</span><div class="reassign-course-controls"><label class="sr-only" for="reassign-course-${course.id}">New instructor for ${escapeHtml(course.name)}</label><select id="reassign-course-${course.id}" data-reassign-select="${course.id}"><option value="">Choose active instructor</option>${activeInstructors.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select><button class="btn btn-outline" type="button" data-reassign-course="${course.id}" ${activeInstructors.length ? '' : 'disabled'}>Reassign</button></div></div>`).join('') : '<span class="instructor-unassigned">No courses assigned.</span>';
    const restoreLabel = statusLabel === 'archived' ? 'Restore archived account' : 'Restore instructor';
    return `<article class="instructor-directory-card"><div class="instructor-directory-person"><strong>${escapeHtml(instructor.name)}</strong><span>@${escapeHtml(instructor.username)} · ${escapeHtml(statusLabel)}</span></div><div class="inactive-course-list">${assignments}</div><button class="btn btn-outline instructor-restore" type="button" data-restore-instructor="${instructor.id}">${restoreLabel}</button></article>`;
  }).join('');
}

function setupAdminInstructorActions(inactiveInstructors, archivedInstructors, courses, activeInstructors) {
  document.querySelectorAll('[data-show-instructor-password-form]').forEach(button => button.addEventListener('click', () => {
    const instructorId = button.dataset.showInstructorPasswordForm;
    const form = document.querySelector(`[data-instructor-password-form="${instructorId}"]`);
    form?.classList.remove('hidden');
    form?.querySelector('input[name="temporaryPassword"]')?.focus();
    button.classList.add('hidden');
  }));
  document.querySelectorAll('[data-cancel-instructor-password]').forEach(button => button.addEventListener('click', () => {
    const instructorId = button.dataset.cancelInstructorPassword;
    const form = document.querySelector(`[data-instructor-password-form="${instructorId}"]`);
    form?.reset();
    form?.classList.add('hidden');
    document.querySelector(`[data-show-instructor-password-form="${instructorId}"]`)?.classList.remove('hidden');
  }));
  document.querySelectorAll('[data-instructor-password-form]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const instructorId = Number(form.dataset.instructorPasswordForm);
    const instructor = activeInstructors.find(item => Number(item.id) === instructorId);
    const values = new FormData(form);
    const temporaryPassword = String(values.get('temporaryPassword') || '');
    if (temporaryPassword !== String(values.get('confirmPassword') || '')) { showToast('The passwords do not match.', true); return; }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/admin/instructors/${instructorId}/password`, { method: 'POST', body: JSON.stringify({ temporaryPassword }) });
      showToast(`${instructor?.name || 'Instructor'}’s password was reset. They must change it at next sign-in.`);
      await renderAdmin();
    } catch (error) { submit.disabled = false; showToast(error.message, true); }
  }));
  document.querySelectorAll('[data-deactivate-instructor]').forEach(button => button.addEventListener('click', async () => {
    const instructorId = Number(button.dataset.deactivateInstructor);
    const instructor = activeInstructors.find(item => Number(item.id) === instructorId);
    if (!instructor) return;
    const courseCount = courses.filter(course => Number(course.instructor_id) === instructorId).length;
    const confirmed = await confirmDialog(`Deactivate ${instructor.name}?`, `They will lose access immediately and any active sessions will end. Their ${courseCount} assigned course${courseCount === 1 ? '' : 's'}, student enrollments, and attendance history will remain. You can reassign courses or restore the account later.`, 'Deactivate instructor', 'Cancel');
    if (!confirmed) return;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/instructors/${instructorId}`, { method: 'DELETE' });
      showToast(`${instructor.name} was deactivated. ${result.endedSessions} active session${result.endedSessions === 1 ? '' : 's'} ended.`);
      await renderAdmin();
    } catch (error) { button.disabled = false; showToast(error.message, true); }
  }));
  document.querySelectorAll('[data-archive-instructor]').forEach(button => button.addEventListener('click', async () => {
    const instructorId = Number(button.dataset.archiveInstructor);
    const instructor = activeInstructors.find(item => Number(item.id) === instructorId);
    if (!instructor) return;
    const courseCount = courses.filter(course => Number(course.instructor_id) === instructorId).length;
    const confirmed = await confirmDialog(`Delete ${instructor.name}?`, `This will archive the account and block sign-in. ${courseCount} assigned course${courseCount === 1 ? '' : 's'}, student enrollments, and attendance history will be retained. You can reassign courses or restore the account from Archived instructors.`, 'Delete and archive', 'Cancel');
    if (!confirmed) return;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/instructors/${instructorId}/archive`, { method: 'POST', body: JSON.stringify({}) });
      showToast(`${instructor.name} was archived. ${result.endedSessions} active session${result.endedSessions === 1 ? '' : 's'} ended; records were retained.`);
      await renderAdmin();
    } catch (error) { button.disabled = false; showToast(error.message, true); }
  }));
  document.querySelectorAll('[data-restore-instructor]').forEach(button => button.addEventListener('click', async () => {
    const instructorId = Number(button.dataset.restoreInstructor);
    const instructor = [...inactiveInstructors, ...archivedInstructors].find(item => Number(item.id) === instructorId);
    if (!instructor) return;
    button.disabled = true;
    try {
      await api(`/api/admin/instructors/${instructorId}/restore`, { method: 'POST', body: JSON.stringify({}) });
      showToast(`${instructor.name} was restored.`);
      await renderAdmin();
    } catch (error) { button.disabled = false; showToast(error.message, true); }
  }));
  document.querySelectorAll('[data-reassign-course]').forEach(button => button.addEventListener('click', async () => {
    const courseId = Number(button.dataset.reassignCourse);
    const course = courses.find(item => Number(item.id) === courseId);
    const select = document.querySelector(`[data-reassign-select="${courseId}"]`);
    const instructor = activeInstructors.find(item => Number(item.id) === Number(select?.value));
    if (!course || !instructor) { showToast('Choose an active instructor first.', true); return; }
    const confirmed = await confirmDialog(`Reassign ${course.code}?`, `${course.name} and its current roster will move to ${instructor.name}. Existing sessions and attendance history will keep their original instructor attribution.`, 'Reassign course', 'Cancel');
    if (!confirmed) return;
    button.disabled = true;
    try {
      await api(`/api/admin/courses/${courseId}/instructor`, { method: 'PATCH', body: JSON.stringify({ instructorId: instructor.id }) });
      showToast(`${course.code} was assigned to ${instructor.name}.`);
      await renderAdmin();
    } catch (error) { button.disabled = false; showToast(error.message, true); }
  }));
}

async function refreshAdminInstructorDirectory() {
  const [instructorResult, courseResult] = await Promise.all([api('/api/admin/instructors'), api('/api/admin/courses')]);
  const instructors = instructorResult.instructors;
  const inactiveInstructors = instructorResult.inactiveInstructors || [];
  const archivedInstructors = instructorResult.archivedInstructors || [];
  const courses = courseResult.courses;
  const directory = document.querySelector('#admin-instructor-directory');
  if (directory) directory.innerHTML = renderInstructorDirectory(instructors, courses);
  const inactiveDirectory = document.querySelector('#admin-inactive-instructors');
  if (inactiveDirectory) inactiveDirectory.innerHTML = renderInstructorRecoveryDirectory(inactiveInstructors, courses, instructors, 'inactive');
  const archivedDirectory = document.querySelector('#admin-archived-instructors');
  if (archivedDirectory) archivedDirectory.innerHTML = renderInstructorRecoveryDirectory(archivedInstructors, courses, instructors, 'archived');
  setupAdminInstructorActions(inactiveInstructors, archivedInstructors, courses, instructors);
  ['admin-course-instructor', 'admin-manage-course-instructor'].forEach(id => {
    const select = document.querySelector(`#${id}`);
    if (select) select.innerHTML = `<option value="">Choose instructor</option>${instructors.map(item => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.username)}</option>`).join('')}`;
  });
  const studentCourse = document.querySelector('#student-course');
  if (studentCourse) studentCourse.innerHTML = `<option value="">Choose course</option>${courses.filter(course => Number(course.instructor_is_active) && !Number(course.instructor_is_archived)).map(course => `<option value="${course.id}">${escapeHtml(course.code)} · ${escapeHtml(course.name)}</option>`).join('')}`;
}

async function addInstructor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  button.disabled = true;
  try {
    const result = await api('/api/admin/instructors', { method: 'POST', body: JSON.stringify({
      name: values.get('name'), username: values.get('username'), temporaryPassword: values.get('temporaryPassword'),
    }) });
    showToast(`${result.instructor.name} was added. Username: ${result.instructor.username}`);
    form.reset();
    await refreshAdminInstructorDirectory();
  } catch (error) {
    const message = error instanceof TypeError && /fetch|network/i.test(error.message)
      ? 'Could not reach the attendance server. Check that it is running, then try again.'
      : error.message;
    showToast(message, true);
  } finally {
    button.disabled = false;
  }
}

function bindAddCourseForm(formId, courseSelectId, options = {}) {
  const form = document.querySelector(`#${formId}`);
  const courseSelect = courseSelectId ? document.querySelector(`#${courseSelectId}`) : null;
  const trigger = document.querySelector(`[data-course-form-target="${formId}"]`);
  if (!form || (courseSelectId && !courseSelect)) return;
  trigger?.addEventListener('click', () => {
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) form.querySelector('input')?.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    const payload = { name: data.get('name'), code: data.get('code') };
    if (data.has('instructorId')) payload.instructorId = Number(data.get('instructorId'));
    submitButton.disabled = true;
    try {
      const result = await api('/api/courses', { method: 'POST', body: JSON.stringify(payload) });
      if (courseSelect) {
        courseSelect.add(new Option(`${result.course.code} · ${result.course.name}`, result.course.id));
        courseSelect.value = String(result.course.id);
      }
      form.reset();
      if (trigger) form.classList.add('hidden');
      showToast(`${result.course.code} · ${result.course.name} was added.`);
      await options.onCreated?.(result.course);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      submitButton.disabled = false;
    }
  });
}

function renderInstructor() {
  clearInterval(qrTimer);
  clearInterval(rosterRefreshTimer);
  app.innerHTML = `<div class="loading-card">Loading instructor dashboard…</div>`;
  Promise.all([api('/api/courses'), api('/api/sessions'), api('/api/departments'), api('/api/reports/daily-attendance'), api('/api/instructor/students')]).then(([courseResult, sessionResult, departmentResult, dailyReport, studentResult]) => {
    const courses = courseResult.courses;
    const history = sessionResult.sessions;
    departmentList = departmentResult.departments;
    const instructorStudents = studentResult.students;
    const openSession = history.find(session => !session.ended_at);
    const course = courses.find(item => Number(item.id) === Number(openSession?.course_id)) || courses[0];
    app.innerHTML = `
      <div class="page-heading"><div><div class="eyebrow">Instructor workspace</div><h1>Good ${greeting()}, ${escapeHtml(activeUser.name.split(' ')[0])}</h1><p>Manage class sessions and keep attendance in one place.</p></div><div class="date-chip">${escapeHtml(new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(new Date()))}</div></div>
      ${dailyAttendanceGraph(dailyReport)}
      ${attendanceReportsSection(instructorStudents, dailyReport.today.date, courses, history, departmentList)}
      <section class="panel instructor-add-student"><div class="panel-head"><div><div class="panel-label">Student accounts</div><h2>Add a student</h2><p>Create an account for one of your courses.</p></div></div>
        <form id="instructor-add-student-form" class="admin-student-form">
          <div class="field"><label for="instructor-student-name">Student name</label><input id="instructor-student-name" name="name" maxlength="100" autocomplete="name" required></div>
          <div class="field"><label for="instructor-student-roll">Roll number (login username)</label><input id="instructor-student-roll" name="rollNumber" maxlength="40" autocomplete="off" required></div>
          <div class="field"><label for="instructor-student-password">Temporary password</label><input id="instructor-student-password" name="temporaryPassword" type="password" minlength="8" autocomplete="new-password" required><small>Student must change this at first sign-in.</small></div>
          <div class="field"><label for="instructor-student-department">Department</label><select id="instructor-student-department" name="departmentId" required>${departmentOptions()}</select></div>
          <div class="field"><label for="instructor-student-year">Year</label><select id="instructor-student-year" name="yearNumber" required>${yearOptions('', '', 'Choose year')}</select></div>
          <div class="field"><label for="instructor-student-course">Course</label><select id="instructor-student-course" name="courseId" required><option value="">Choose course</option>${courses.map(item => `<option value="${item.id}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select><button class="course-add-trigger" type="button" data-course-form-target="instructor-add-course-form">＋ Add a new course</button></div>
          <button class="btn btn-primary" type="submit">＋ Add student</button>
        </form>
        <form id="instructor-add-course-form" class="course-create-form hidden">
          <h3>Add a new course</h3>
          <div class="course-create-fields"><div class="field"><label for="instructor-course-name">Course name</label><input id="instructor-course-name" name="name" maxlength="100" required></div><div class="field"><label for="instructor-course-code">Course code</label><input id="instructor-course-code" name="code" maxlength="20" required></div></div>
          <button class="btn btn-outline" type="submit">＋ Create course</button>
        </form>
      </section>
      <div class="dashboard-grid">
        <section class="panel">
          <div class="panel-head"><div><div class="panel-label">Your courses</div><h2 id="instructor-selected-course-name">${escapeHtml(course?.name || 'No course available')}</h2><p>${courses.length > 1 ? 'Choose the class for your next session.' : 'Launch a new session whenever your class begins.'}</p></div><div class="instructor-course-picker"><label for="instructor-session-course">${openSession ? 'Active course' : 'Course'}</label><select id="instructor-session-course" ${openSession || !courses.length ? 'disabled' : ''}>${courses.map(item => `<option value="${item.id}" ${Number(item.id) === Number(course?.id) ? 'selected' : ''}>${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select></div></div>
          ${course ? `<div class="course-summary"><div><div id="instructor-selected-course-summary" class="course-name">${escapeHtml(course.name)}</div><div id="instructor-selected-course-meta" class="course-meta">${escapeHtml(course.code)} · Instructor: ${escapeHtml(course.instructor_name || activeUser.name)}</div></div><span class="course-code">${openSession ? 'SESSION IN PROGRESS' : 'CLASS TEACHER'}</span></div>` : ''}
          <div id="session-area"></div>
          <div class="session-list"><div class="session-list-heading"><h3>Recent sessions</h3><span>Latest 20</span></div><div id="session-history">${renderSessionHistory(history)}</div></div>
        </section>
        <section class="panel">
          <div class="panel-head"><div><div class="panel-label">Live check-in</div><h2>Session QR code</h2><p>Refreshes automatically every 10 seconds.</p></div></div>
          <div id="qr-area"></div>
        </section>
      </div>
      <section class="panel department-panel">
        <div class="panel-head"><div><div class="panel-label">Academic groups</div><h2>Departments &amp; year groups</h2><p>Choose a department, then a year to see its students and today’s attendance totals.</p></div></div>
        <div class="department-grid">${departmentList.map(department => `<button class="department-chip department-button" type="button" data-instructor-department="${department.id}" aria-pressed="false"><span class="department-symbol">${escapeHtml(initials(department.name))}</span><span><strong>${escapeHtml(department.name)}</strong><small>${department.year_count} year groups · ${instructorStudents.filter(student => String(student.department_id) === String(department.id)).length} students</small></span></button>`).join('')}</div>
        <div id="instructor-year-buttons" class="year-button-row hidden"></div>
        <div id="instructor-group-summary" class="group-summary">${presentTodaySummary(instructorStudents)}</div>
        <div id="instructor-group-results" class="table-wrap hidden"></div>
        <form id="add-department-form" class="add-department-form">
          <div class="field"><label for="new-department-name">Add a department</label><input id="new-department-name" name="name" maxlength="50" placeholder="For example, B.Tech" required></div>
          <div class="field"><label for="new-department-years">Years in program</label><select id="new-department-years" name="yearCount">${Array.from({ length: 6 }, (_, index) => `<option value="${index + 1}" ${index === 2 ? 'selected' : ''}>${index + 1} years</option>`).join('')}</select></div>
          <button class="btn btn-outline" type="submit">＋ Add department</button>
        </form>
      </section>
      <section id="roster-panel" class="panel roster-card hidden"></section>`;
    document.querySelector('#session-area').innerHTML = openSession
      ? renderActiveSession(openSession)
      : `<div class="session-placeholder"><span class="placeholder-icon">◷</span><h3>Ready for your next class?</h3><p>Start a session to display a live QR code for student check-ins.</p><button id="start-session" class="btn btn-primary" type="button">＋ Start class session</button></div>`;
    document.querySelector('#instructor-session-course')?.addEventListener('change', event => {
      const selected = courses.find(item => String(item.id) === event.target.value);
      if (!selected) return;
      document.querySelector('#instructor-selected-course-name').textContent = selected.name;
      document.querySelector('#instructor-selected-course-summary').textContent = selected.name;
      document.querySelector('#instructor-selected-course-meta').textContent = `${selected.code} · Instructor: ${selected.instructor_name || activeUser.name}`;
    });
    document.querySelector('#start-session')?.addEventListener('click', () => startSession(Number(document.querySelector('#instructor-session-course')?.value || course?.id)));
    document.querySelector('#end-session')?.addEventListener('click', () => endSession(openSession.id));
    document.querySelector('#open-roster')?.addEventListener('click', () => loadRoster(openSession.id));
    document.querySelectorAll('[data-view-roster]').forEach(button => button.addEventListener('click', () => loadRoster(Number(button.dataset.viewRoster))));
    document.querySelector('#add-department-form').addEventListener('submit', addDepartment);
    document.querySelector('#instructor-student-department').addEventListener('change', event => {
      document.querySelector('#instructor-student-year').innerHTML = yearOptions(event.target.value, '', 'Choose year');
    });
    document.querySelector('#instructor-add-student-form').addEventListener('submit', addInstructorStudent);
    bindAddCourseForm('instructor-add-course-form', 'instructor-student-course');
    setupInstructorDepartmentBrowser(instructorStudents);
    bindAttendanceReports(dailyReport.today.date, instructorStudents, { courses, sessions: history });
    if (openSession) loadQr(openSession.id);
  }).catch(error => showToast(error.message, true));
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

function renderActiveSession(session) {
  return `<div class="active-session"><div class="active-label"><span class="pulse"></span>Session in progress</div><div class="session-meta"><strong>${escapeHtml(session.course_name)}</strong> · Started ${escapeHtml(dateLabel(session.started_at))}</div><div class="session-actions"><button id="open-roster" class="btn btn-outline" type="button">View attendance</button><button id="end-session" class="btn btn-dark" type="button">End session</button></div></div>`;
}

function renderSessionHistory(sessions) {
  if (!sessions.length) return '<div class="empty-list">Your completed sessions will appear here.</div>';
  return sessions.map(session => `<div class="session-row">
    <div><div class="session-row-title">${escapeHtml(session.course_code)} · Session ${session.id}</div><div class="session-row-date">${escapeHtml(dateLabel(session.started_at))}${session.ended_at ? '' : ' · In progress'}</div></div>
    <div class="session-count">${session.present_count}/${session.roster_count} present</div>
    <button class="small-link" type="button" data-view-roster="${session.id}">Roster →</button>
  </div>`).join('');
}

async function startSession(courseId) {
  if (!courseId) return showToast('No course has been set up for this account.', true);
  try {
    const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ courseId }) });
    showToast('Class session started. The QR code is live.');
    await renderInstructor();
  } catch (error) { showToast(error.message, true); }
}

async function addDepartment(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/departments', { method: 'POST', body: JSON.stringify({ name: form.get('name'), yearCount: Number(form.get('yearCount')) }) });
    showToast('Department added.');
    await renderInstructor();
  } catch (error) { showToast(error.message, true); }
}

async function endSession(sessionId) {
  const confirmed = await confirmDialog('End this class session?', 'Students will no longer be able to check in with the QR code. You can still view or export the roster.');
  if (!confirmed) return;
  try {
    await api(`/api/sessions/${sessionId}/end`, { method: 'POST', body: '{}' });
    showToast('Session ended.');
    await renderInstructor();
  } catch (error) { showToast(error.message, true); }
}

async function loadQr(sessionId) {
  clearTimeout(qrTimer);
  const target = document.querySelector('#qr-area');
  if (!target) return;
  target.innerHTML = '<div class="session-placeholder"><span class="placeholder-icon">▦</span><h3>Preparing your QR code…</h3><p>It will appear here in a moment.</p></div>';

  const refresh = async () => {
    try {
      const result = await api(`/api/sessions/${sessionId}/qr`);
      const frame = document.querySelector('#qr-frame');
      const existingLink = document.querySelector('#qr-link');
      if (frame) frame.innerHTML = result.svg;
      else target.innerHTML = `<div class="qr-layout"><div class="qr-frame" id="qr-frame">${result.svg}</div><div class="qr-info"><h3>Ready to check in</h3><p>Ask students to scan this code with their phone camera. Each code expires after 10 seconds.</p><div class="timer"><span id="timer-label">New code in ${result.expiresIn}s</span><span class="timer-track"><span id="timer-fill" class="timer-fill" style="display:block;width:${(result.expiresIn / 10) * 100}%"></span></span></div><a id="qr-link" class="qr-link" href="${escapeHtml(result.checkinUrl)}">${escapeHtml(result.checkinUrl)}</a></div></div>`;
      if (existingLink) {
        existingLink.href = result.checkinUrl;
        existingLink.textContent = result.checkinUrl;
      }
      let left = result.expiresIn;
      const timerLabel = document.querySelector('#timer-label');
      const timerFill = document.querySelector('#timer-fill');
      const oldCountdown = window.qrCountdown;
      if (oldCountdown) clearInterval(oldCountdown);
      window.qrCountdown = setInterval(() => {
        left -= 1;
        if (timerLabel) timerLabel.textContent = left > 0 ? `New code in ${left}s` : 'Refreshing code…';
        if (timerFill) timerFill.style.width = `${Math.max(0, (left / 10) * 100)}%`;
        if (left <= 0) clearInterval(window.qrCountdown);
      }, 1000);
      clearTimeout(qrTimer);
      qrTimer = setTimeout(refresh, Math.max(50, result.expiresIn * 1000));
    } catch (error) {
      if (document.querySelector('#qr-area')) target.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`;
      if (/ended|not found/i.test(error.message)) clearInterval(qrTimer);
    }
  };

  await refresh();
}

async function loadRoster(sessionId, backgroundRefresh = false) {
  clearInterval(rosterRefreshTimer);
  try {
    const query = new URLSearchParams();
    if (rosterFilters.departmentId) query.set('departmentId', rosterFilters.departmentId);
    if (rosterFilters.yearNumber) query.set('yearNumber', rosterFilters.yearNumber);
    const suffix = query.size ? `?${query}` : '';
    const result = await api(`/api/sessions/${sessionId}/attendance${suffix}`);
    const panel = document.querySelector('#roster-panel');
    if (!panel) return;
    const present = result.roster.filter(row => row.present).length;
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="panel-head"><div><div class="panel-label">Session ${sessionId}</div><h2>Attendance roster</h2><p>${escapeHtml(result.session.course_name)} · Started ${escapeHtml(dateLabel(result.session.started_at))}</p></div><div class="roster-toolbar"><span class="count-pill">${present} / ${result.roster.length} present</span><button id="export-roster" class="btn btn-outline" type="button">↓ Export CSV</button></div></div>
      <div class="report-filters"><label><span>Department</span><select id="report-department"><option value="">All departments</option>${departmentList.map(department => `<option value="${department.id}" ${String(rosterFilters.departmentId) === String(department.id) ? 'selected' : ''}>${escapeHtml(department.name)}</option>`).join('')}</select></label><label><span>Year</span><select id="report-year">${yearOptions(rosterFilters.departmentId, rosterFilters.yearNumber)}</select></label></div>
      <div class="table-wrap"><table><thead><tr><th>Student</th><th>Department / year</th><th>Status</th><th>Check-in method</th><th>Marked at</th><th></th></tr></thead><tbody>${result.roster.map(row => `<tr><td><div class="student-cell"><span class="avatar">${escapeHtml(initials(row.name))}</span>${escapeHtml(row.name)}</div></td><td>${escapeHtml(row.department_name ? `${row.department_name} · ${yearLabel(row.year_number)}` : 'Not selected')}</td><td><span class="status ${row.present ? 'status-present' : 'status-absent'}">${row.present ? 'Present' : 'Absent'}</span></td><td><span class="method-tag">${row.method === 'qr' ? 'QR scan' : row.method === 'manual' ? 'Manual' : '—'}</span></td><td>${escapeHtml(row.marked_at ? dateLabel(row.marked_at) : '—')}</td><td>${row.present ? '' : `<button class="small-link" type="button" data-mark-present="${row.student_id}">Mark present</button>`}</td></tr>`).join('')}</tbody></table></div>${result.roster.length ? '' : '<div class="empty-list">No students match this department and year filter.</div>'}`;
    document.querySelector('#export-roster').addEventListener('click', () => { location.href = `/api/sessions/${sessionId}/export.csv${suffix}`; });
    document.querySelector('#report-department').addEventListener('change', event => {
      rosterFilters.departmentId = event.target.value;
      rosterFilters.yearNumber = '';
      loadRoster(sessionId);
    });
    document.querySelector('#report-year').addEventListener('change', event => {
      rosterFilters.yearNumber = event.target.value;
      loadRoster(sessionId);
    });
    panel.querySelectorAll('[data-mark-present]').forEach(button => button.addEventListener('click', () => markManual(sessionId, Number(button.dataset.markPresent))));
    if (!backgroundRefresh) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    rosterRefreshTimer = setTimeout(() => loadRoster(sessionId, true), 5000);
  } catch (error) { showToast(error.message, true); }
}

async function markManual(sessionId, studentId, refresh = () => loadRoster(sessionId)) {
  try {
    await api(`/api/sessions/${sessionId}/attendance/manual`, { method: 'POST', body: JSON.stringify({ studentId }) });
    showToast('Attendance recorded manually.');
    await refresh();
  } catch (error) { showToast(error.message, true); }
}

async function renderStudent() {
  clearInterval(qrTimer);
  clearInterval(rosterRefreshTimer);
  app.innerHTML = '<div class="loading-card">Loading your courses…</div>';
  try {
    const [result, departmentResult] = await Promise.all([api('/api/courses'), api('/api/departments')]);
    departmentList = departmentResult.departments;
    const course = result.courses[0];
    const hasProfile = Boolean(activeUser.departmentId);
    const groupDisplay = hasProfile
      ? `<div class="student-group-display"><div><div class="panel-label">Your department &amp; year</div><strong>${escapeHtml(activeUser.departmentName)} · ${yearLabel(activeUser.yearNumber)}</strong></div><button id="edit-group" class="btn btn-outline" type="button">Change</button></div>`
      : '<div class="scan-status">Choose your department and year so instructors can filter attendance reports by student group.</div>';
    app.innerHTML = `<div class="student-dashboard"><div class="welcome-strip"><div><div class="eyebrow">Student portal</div><h1>Welcome, ${escapeHtml(activeUser.name.split(' ')[0])}</h1><p>Your class attendance, all in one place.</p></div><span class="welcome-mark">✓</span></div>
      <section class="panel student-group-card"><div class="panel-head"><div><div class="panel-label">Student profile</div><h2>Department &amp; year group</h2><p>Pick the program and year you’re currently studying.</p></div></div>
      ${groupDisplay}
      <form id="student-profile-form" class="student-profile-form ${hasProfile ? 'hidden' : ''}">
        <div class="field"><label for="student-department">Department</label><select id="student-department" name="departmentId" required>${departmentOptions(activeUser.departmentId || '')}</select></div>
        <div class="field"><label for="student-year">Year</label><select id="student-year" name="yearNumber" required>${yearOptions(activeUser.departmentId || '', activeUser.yearNumber || '', 'Choose year')}</select></div>
        <button class="btn btn-primary" type="submit">Save my group</button>
      </form>
      </section>
      <section class="panel student-course-card"><div class="panel-head"><div><div class="panel-label">My course</div><h2>${escapeHtml(course?.name || 'No courses yet')}</h2><p>${escapeHtml(course ? `${course.code} · Instructor: ${course.instructor_name || 'Jordan Lee'}` : 'You have not been enrolled in a course.')}</p></div><span class="course-code">${escapeHtml(course?.code || '—')}</span></div>
      <div class="course-detail-line"><span>How to check in</span><strong>Scan the live QR code. Attendance is recorded automatically.</strong></div>
      ${pendingCheckin ? '<div id="checkin-status" class="scan-status">Recording attendance for your scanned class…</div>' : '<div class="scan-status">When your instructor starts class, scan the projected QR code with your phone camera. Sign in if prompted; attendance will be recorded automatically.</div>'}
      </section></div>`;
    document.querySelector('#edit-group')?.addEventListener('click', () => document.querySelector('#student-profile-form').classList.toggle('hidden'));
    document.querySelector('#student-department').addEventListener('change', event => {
      document.querySelector('#student-year').innerHTML = yearOptions(event.target.value, '', 'Choose year');
    });
    document.querySelector('#student-profile-form').addEventListener('submit', saveStudentProfile);
    if (pendingCheckin) await submitCheckin(pendingCheckin);
  } catch (error) { app.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`; }
}

async function saveStudentProfile(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/me/profile', { method: 'POST', body: JSON.stringify({ departmentId: Number(form.get('departmentId')), yearNumber: Number(form.get('yearNumber')) }) });
    setUser(result.user);
    showToast('Your department and year were saved.');
    await renderStudent();
  } catch (error) {
    button.disabled = false;
    showToast(error.message, true);
  }
}

async function submitCheckin(checkin) {
  if (!activeUser || activeUser.role !== 'student') return;
  const status = document.querySelector('#checkin-status');
  if (status) status.textContent = 'Checking that QR code…';
  try {
    const result = await api('/api/attendance/check-in', { method: 'POST', body: JSON.stringify({ sessionId: checkin.sessionId, token: checkin.token }) });
    if (status) {
      status.className = 'scan-status success';
      status.textContent = result.alreadyPresent ? 'You’re all set — your attendance was already recorded for this class.' : 'You’re all set — your attendance has been recorded.';
    }
  } catch (error) {
    if (status) {
      status.className = 'scan-status error';
      status.textContent = error.message;
    }
  }
  if (history.replaceState) history.replaceState({}, '', '/');
}

function confirmDialog(title, message, confirmLabel = 'End session', cancelLabel = 'Keep session open') {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><div class="modal-actions"><button class="btn btn-outline" data-choice="no" type="button">${escapeHtml(cancelLabel)}</button><button class="btn btn-dark" data-choice="yes" type="button">${escapeHtml(confirmLabel)}</button></div></section>`;
    document.body.append(backdrop);
    backdrop.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
      const result = button.dataset.choice === 'yes';
      backdrop.remove();
      resolve(result);
    }));
  });
}

bootstrap();
