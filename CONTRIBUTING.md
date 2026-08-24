# Contributing to ShotTap

Thanks for your interest in ShotTap. This project handles screen capture, clipboard operations, recordings, and local file deletion, so focused changes and careful testing matter.

## Development Setup

```bash
git clone https://github.com/VLStudio1/shottap.git
cd shottap
npm ci
npm start
```

## Branches

Create a branch for each focused change:

```bash
git checkout -b fix/short-description
```

Keep pull requests scoped to one issue or improvement. Avoid unrelated formatting churn.

## Tests

Run the Node test suite:

```bash
npm test
```

Run the Electron self-test when your environment supports windows, hotkeys, capture, and recording:

```bash
npm run selftest
```

Build the Windows release artifacts:

```bash
npm run dist
```

## UI Changes

For visual changes, include screenshots or short recordings in the pull request. Please remove or redact sensitive information before attaching any media.

## Behavior Changes

Update or add tests when behavior changes. Changes in these areas should receive extra care:

- Global hotkeys
- Clipboard operations
- Screenshot capture behavior
- Recording behavior
- File deletion, trash, and restore flows
- Security boundaries between Electron main, preload, and renderer code
- Local file/protocol access

## Documentation

Update documentation when commands, shortcuts, settings, release artifacts, privacy behavior, or user-facing workflows change.

## Pull Requests

Before opening a pull request, check that:

- The scope is focused.
- Tests pass locally where practical.
- New tests are included for behavior changes.
- UI screenshots are included for visual changes.
- No sensitive/private data is included.
- Documentation is updated when needed.
