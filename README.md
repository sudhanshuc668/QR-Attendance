# Disha Institute of Science and Technology Attendance

A college attendance web app with admin and instructor dashboards, student rosters, live rotating QR check-in, and attendance reports.

## Local development

Requirements: Node.js 22.5 or newer, Python 3.9 or newer, and pip.

```powershell
python -m pip install -r requirements.txt
npm start
```

Open [http://localhost:3000](http://localhost:3000). Local development uses SQLite in `attendance.db` and seeds demo accounts only when no users are present. Demo credentials are for local development only and must never be used on a public deployment.

The database and SQLite journal files are ignored by Git. Do not commit them; they may contain student information.

## Public deployment

The repository includes a Render Docker service definition. The public service uses PostgreSQL; local development continues to use SQLite.

1. Create an empty Neon PostgreSQL database and keep its connection string private.
2. Set `DATABASE_URL`, `INITIAL_ADMIN_USERNAME`, and `INITIAL_ADMIN_PASSWORD` in a secure local environment. The admin password must be 12–128 characters.
3. Run `npm run migrate:postgres` once, before starting the hosted app. The migration reads the local `attendance.db`, preserves non-demo accounts and related records, and creates the initial admin. It excludes the built-in demo usernames and their linked sample data. It prints record counts only.
4. Connect this GitHub repository to Render using `render.yaml`. Set the same database and initial-admin secrets in Render; Render generates `QR_SECRET` through the blueprint. Never commit or share these values.

The migration refuses to write into a PostgreSQL database that already contains application data. Back up `attendance.db` before migration. Keep it local and private.

Render’s free web service may sleep after inactivity, so the first request can take longer and in-memory sign-in sessions may need to be recreated after a restart. Neon’s free database plan has storage and compute limits; check the provider dashboards for current usage and plan details.

The website URL is publicly reachable, but student, instructor, and admin data stays behind sign-in. Production does not seed the local demo accounts. The admin signs in with the configured initial credentials and must set a new password at first sign-in.

## Features

- Instructors can manage their assigned courses and students, run sessions, display rotating QR codes, review attendance, and export rosters.
- Students scan the QR code and sign in; attendance is recorded automatically when the active session and course enrollment are valid.
- Admins can create instructors and students, assign courses, change a student’s department/year, manage departments, and review attendance.
- Departments have year groups; admins and instructors can filter students and attendance by department and year.
- The login and dashboard use Disha Institute of Science and Technology branding, with light and dark themes.
- Passwords are salted and hashed. Production session cookies use `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.

## Configuration

- `PORT`: server port; Render provides this automatically.
- `HOST`: bind address (defaults to `0.0.0.0`).
- `DATABASE_URL`: when set, use PostgreSQL; otherwise use local SQLite.
- `QR_SECRET`: stable, private QR-token signing secret. Render generates one from the blueprint.
- `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`, `INITIAL_ADMIN_NAME`: create the initial admin in a new PostgreSQL database. Set the username and password in secret settings. The password must be 12–128 characters.
- `SQLITE_PATH`: optional alternate path for the local SQLite database.
