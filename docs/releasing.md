# Releasing Shellmate

Shellmate ships as a Windows NSIS installer attached to a GitHub Release. Everything builds on a Windows development machine; no GitHub Actions are used.

## Release outputs

The release pipeline creates:

- `release/Shellmate-Setup-VERSION.exe`
- `release/Shellmate-Setup-VERSION.exe.sha256`

`release/` is ignored by Git. Do not commit installers or checksums. The installer is not code-signed, so SmartScreen warns on first run; the README tells users how to proceed.

## Local release

Close any Shellmate started from `release/win-unpacked` first, because a running copy locks `app.asar`. Then, from a clean checkout:

```powershell
npm ci
npm run release
```

The release script:

- requires a clean Git working tree;
- runs `npm run typecheck`;
- clears `release/` and runs `npm run package` (build plus electron-builder);
- checks that `release/Shellmate-Setup-VERSION.exe` exists, with the version taken from `package.json`;
- writes a SHA-256 checksum next to the installer.

Smoke-test `release/win-unpacked/Shellmate.exe` or the installer before publishing.

## Version and publish workflow

1. Bump `version` in `package.json` and run `npm install --package-lock-only` to update the lockfile.
2. Commit the version change and confirm the working tree is clean.
3. Optionally write release notes to a file outside the repository.
4. Run the publish script from `main`:

```powershell
npm run publish
npm run publish -- -NotesFile C:\path\to\notes.md
```

The publish script refuses to run if `main` is behind `origin/main`, if the release already exists, or if an existing `vX.Y.Z` tag points somewhere other than `HEAD`. It reruns the local release, creates an annotated tag matching the package version, pushes `main` and the tag, and creates a public GitHub Release with the installer and checksum. Without `-NotesFile` it uses GitHub's generated notes. Pass `-Tag vX.Y.Z` only when an explicit tag is useful; it must still match the package version.

Publishing requires an authenticated GitHub CLI (`gh auth status`) with permission to push the repository and create releases.

## Icons

`build/icon.png` (1024×1024) is the master logo. `npm run icons` regenerates `build/icon.ico` (the exe, installer, window, and taskbar icon) and `src/renderer/assets/logo.png` (the header and favicon) with ImageMagick 7. Commit the regenerated files with the master.
