# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.6.0] - 2026-11-08

### Added

- Added Reverse Search: drop or browse for an image to find visual copies — exact matches and near-duplicates such as resized or re-saved files — stored on this computer.
- Reverse Search always covers the capture library and any folders you add; picked folders are remembered between sessions.
- Added a "Find similar images" action to the capture context menu.
- Added a persisted image-hash cache so repeat searches skip already-hashed files.

### Fixed

- Browsing for an image now shows the searching state and progress immediately after the file is chosen, instead of appearing to do nothing while the search ran silently.
- Tamed Reverse Search resource use: each search now compares against the newest 5,000 images (and says so when the folders hold more), decodes one image at a time so captures and the UI stay responsive, hashes library captures from their stored thumbnails instead of full files, and can be cancelled mid-search.

### Notes

- Reverse Search runs fully offline with perceptual hashing (dHash); no images leave the machine and no new dependencies were added.

## [0.5.3] - 2026-08-31

### Added

- Added line, rectangle, square, ellipse, and circle tools to the screenshot editor.
- Added deeper self-test coverage for Copy All after clearing the clipboard, after clearing the session queue, and with large screenshot sets.

### Fixed

- Made Copy All fall back to the Captures library when the current session queue is empty.
- Added a bounded composite image fallback so paste targets that ignore multi-file clipboard data still receive all copied screenshots as one image.

## [0.5.2] - 2026-08-24

### Changed

- Kept Clear All and Empty Trash shortcuts out of the Quick Capture dashboard so the main capture tab matches the public screenshots.

## [0.5.1] - 2026-08-24

### Added

- Added configurable global shortcuts for Clear All and Empty Trash.
- Added clearer README download links for the Windows installer and portable EXE.

## [0.5.0] - 2026-08-24

### Added

- Area screenshot capture.
- Full-screen screenshot capture.
- Area screen recording.
- Full-screen screen recording.
- Global keyboard shortcuts for capture, recording, and Copy All.
- Instant screenshot clipboard copy.
- Multi-capture clipboard queue and Copy All workflow.
- WebM recording with system audio and optional microphone audio.
- Recording quality options for native, 1080p, and 720p.
- Recording frame-rate options for 24, 30, and 60 FPS where supported.
- Local capture and recording library.
- Search, sort, filter, favorites, trash, restore, and empty-trash library flows.
- Grid and list library layouts with inspector/details view.
- Screenshot editor with pencil, eraser, brush color, brush size, undo, and redo.
- Light, dark, and system theme options.
- Configurable hotkeys.
- Configurable save location.
- Windows installer and portable build targets.

### Changed

- Prepared public branding and release metadata around the ShotTap name.

### Security

- Documented local-first privacy posture and private vulnerability reporting guidance.
