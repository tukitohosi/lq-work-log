# L.Q Work Log

[简体中文](README.md) | English

**Offline attendance and payroll, from daily work to monthly totals.**

Track morning, afternoon and overtime work, leave, work sites, allowances, deductions and settlement status. Review monthly and yearly totals and export Excel, PDF or complete backups.

Current versions: **Windows 2.2.1 · Android 2.2.2**. [Windows download](https://github.com/tukitohosi/lq-work-log/releases/tag/v2.2.1) · [Android download](https://github.com/tukitohosi/lq-work-log/releases/tag/v2.2.2-android)

## Features

- Add workers individually or in batches and record attendance, overtime and paid/unpaid leave.
- Use clicks, dragging, selection, keyboard entry and up to 50 undo steps on desktop.
- Use a complete monthly calendar, automatic daily saving and batch attendance on mobile.
- Keep effective-month wage history without rewriting earlier months.
- Review staffing and work-site costs, record adjustments and mark payroll settled.
- Export Excel and print/PDF reports, plus complete JSON backups.
- Use internal backups and optional weekly external backups on Windows.

## Install

- Windows x64: LQ-Work-Log-2.2.1-Setup.exe, with the runtime included.
- Android 7.0+: LQ-Work-Log-2.2.2-Android.apk.

The Android APK uses the release signing key. AAB files are for store submission, not direct installation.

Add a worker and daily wage, then record work in the calendar. Open a day's details for notes, leave and site assignments.

## Data and limitations

The app works offline and stores data locally. It has no online account or automatic cross-device synchronization.

Use complete JSON for backups and migration. Excel and PDF are reports and cannot restore data. Android uninstall removes private app data: export JSON before upgrading and install the update over the existing app.

Windows data is under the current user's AppData/Roaming/L.Q记工本/data directory. Normal uninstall keeps it. Weekly external backups retain the latest 12 files by default. A single application-data file is limited to 64 MiB.

Workers and sites referenced by historical records are archived rather than permanently deleted.

## Development

Windows source requires Node.js 22.12 or newer.

~~~powershell
npm ci
npm run build
npm run desktop:start
~~~

See [android-app](android-app/README.md) for Android source and build requirements.
