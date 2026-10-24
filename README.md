# RollCall — Rotating QR Attendance

A local classroom demo for recording attendance with QR codes that refresh every 10 seconds. The app uses plain HTML, CSS, and JavaScript, a dependency-free Node.js HTTP server, and SQLite through Node's built-in `node:sqlite` module.

## Requirements

- Node.js 22.5 or newer (the included environment uses Node 24).
- Python 3.9 or newer and pip, used only to render QR codes as SVG.

## Run locally

```powershell
python -m pip install -r requirements.txt
node server.js
```

Open [http://localhost:3000](http://localhost:3000). Node creates `attendance.db` in the project directory the first time it starts and seeds the sample users and course.

### Demo accounts

| Role | Username | Password |
| --- | --- | --- |
| Admin | `admin` | `admin123` |
| Instructor | `instructor` | `teach123` |
| Student | `student1` | `student123` |
| Student | `student2` | `student223` |
| Student | `student3` | `student323` |
| Student | `student4` | `student423` |
| Student | `student5` | `student523` |
| Student | `student6` | `student623` |

## Phone scanning on the same Wi-Fi

The server listens on all network interfaces. Find the laptop's local IP address, then open `http://<laptop-ip>:3000` on the phone once so the browser accepts the site. The QR code link uses the host address from the instructor's page. Keep both devices on the same Wi-Fi and allow Node through the laptop's firewall if prompted. This local HTTP setup is intended for a classroom demo, not public internet hosting.

## What it does

- Instructors start and end a class session, display a self-refreshing QR code, review the roster, manually mark students present, download a CSV, and add student accounts to their own courses.
- Students scan the QR code with their phone camera. The link opens the app; after sign-in, the student verifies their face and the server checks the token before recording attendance.
- Students choose their department and year after signing in. BCA, BBA, B.Com, and B.Sc are seeded with three year groups each; instructors can add more departments with one to six years.
- Instructors can filter a session roster and its CSV export by department and year. The attendance session itself still covers the full course roster.
- Instructor and admin dashboards let you select a department, then a year group (First Year, Second Year, Third Year, and so on) to view that group’s students, how many are present today, and how many are not yet marked. Instructor views only include their own courses.
- Instructors and admins can add students with a name, unique roll number, department/year, course, and temporary password. Students enroll their face after signing in, on the device and browser they will use for attendance.
- New students sign in with their roll number and temporary password, then must change the password before using attendance.
- After a QR scan and sign-in, students take a fresh selfie and verify it against their local face template before attendance is recorded. The template stays in that browser's local storage; selfies and templates are not sent to the server. Remove an enrollment from the student face check-in panel. The face library and models load from jsDelivr, which requires internet access the first time.
- Face matching is a classroom-project demo with no liveness or reliable anti-spoofing. Because the template stays on the device, the server cannot independently verify a match; a technically capable user can bypass this client-side check. Instructors can manually mark attendance if face check-in fails.
- The QR token is signed by the server and expires at the next 10-second boundary. The server's clock is authoritative.
- Passwords are salted and hashed. Authentication cookies are `HttpOnly` and `SameSite=Lax`.

## Data and configuration

The SQLite database is stored in `attendance.db`. To start a fresh demo, stop the server and delete that file; it will be reseeded on next launch. `PORT` and `HOST` can be configured with environment variables. Set `QR_SECRET` to a long random value for a stable signing secret; without it, tokens are still validated but existing QR tokens stop working when the server restarts.
