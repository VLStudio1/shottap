# Security Policy

ShotTap handles screen content, recordings, clipboard data, and local files. Please take care not to expose sensitive information when reporting issues.

## Reporting a Vulnerability

Do not report security vulnerabilities in public GitHub Issues.

Use GitHub's private vulnerability reporting or security advisory system for this repository:

https://github.com/VLStudio1/shottap/security/advisories/new

If private reporting is not available yet, wait for the maintainers to publish an approved private contact channel rather than posting exploit details publicly.

## Sensitive Attachments

Do not attach sensitive personal screenshots, recordings, or logs publicly.

Before sharing diagnostics:

- Redact passwords, tokens, account numbers, personal messages, and private documents.
- Crop screenshots to only the relevant UI when possible.
- Avoid sharing recordings that show private windows, notifications, or browser tabs.
- Review logs for local paths, usernames, file names, or other private context.

## Scope

Security-sensitive areas include:

- Capture and recording behavior
- Clipboard writes and clipboard clearing
- File deletion, trash, restore, and empty-trash flows
- Local media serving and path traversal protections
- Electron main/preload/renderer boundaries
- Global shortcut handling

## Privacy Posture

ShotTap is currently local-first. It does not require an account and does not contain telemetry, analytics, advertising, or built-in cloud-upload functionality.
