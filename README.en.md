# L.Q Work Log 2.2.1

[简体中文](README.md) | English

## Android 2.2.2

The Android app is now at version 2.2.2, with a complete monthly calendar, automatic saving for daily edits, and an explicit batch attendance mode. See the [Android source](android-app/) and [Android 2.2.2 release](https://github.com/tukitohosi/lq-work-log/releases/tag/v2.2.2-android). The Windows release remains at 2.2.1.

## Overview

L.Q Work Log is a fully offline Windows attendance and payroll tool for individuals and small teams. It tracks workers, daily attendance, overtime, leave, work sites, allowances, deductions, and settlement status, then produces monthly and yearly summaries together with Excel and print/PDF reports.

The current release is **v2.2.1**.

## Highlights

- Add workers individually or in batches with their daily rates.
- Record morning, afternoon, and overtime attendance by clicking, dragging, or using keyboard shortcuts.
- Track paid and unpaid leave, daily notes, and the actual work site for each period.
- Review daily staffing, site-level monthly or yearly cost, and annual settlement summaries.
- Record allowances and deductions and mark payroll as settled.
- Maintain effective-month wage history without rewriting prior months.
- Export Excel and PDF reports, plus complete JSON backups for recovery and migration.
- Use built-in daily, pre-restore, and optional weekly external backups.

## Install

1. Open [Releases](https://github.com/LQ-FJUT/lq-work-log/releases).
2. Download `L.Q记工本-2.2.1-Setup.exe`.
3. Run the installer for the current Windows user.

The installer is unsigned, so Windows may show an unknown-publisher warning. Verify the SHA-256 value on the Release page before running it.

## Basic use

1. Add one worker or batch-add a list with daily rates.
2. Record attendance in the monthly grid by mouse or keyboard.
3. Open a day's details to enter notes, leave, and actual work-site assignments.
4. Use Daily Overview, Site Statistics, and Annual Summary to reconcile staffing and cost.
5. Record allowances or deductions and update settlement status when wages are paid.
6. Export complete JSON for backups or migration. Excel and PDF are report formats and cannot restore application data.

## Data and backups

Production data is stored in `%APPDATA%\L.Q记工本\data`, separate from the installation directory. Writes are validated, serialized, and atomically replaced. By default, the desktop app creates a weekly external JSON backup in the Windows `Documents\L.Q记工本备份` folder. The uninstaller does not intentionally delete user data, but a manual complete JSON export is still recommended before important operations.

## Run from source

You need Node.js 22.12 or newer.

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run desktop:start
```

Build the production Windows installer:

```powershell
npm run desktop:make
```

## Release status

This repository contains the final source for v2.2.1, while the installer is distributed through GitHub Releases. The local release pipeline, ASAR audit, and desktop smoke test do not replace acceptance testing on a clean Windows computer without Node.js, including first install, upgrade from 2.2.0, uninstall, and data-retention checks.
