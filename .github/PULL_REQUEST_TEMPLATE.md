## Summary

<!-- What changed and why. Link the issue if one exists. -->

## Area

- [ ] Assist / on-device AI
- [ ] Map / offline packs
- [ ] Chat / Bluetooth mesh
- [ ] SOS
- [ ] Kit / preparedness
- [ ] Onboarding / downloads
- [ ] Build / release
- [ ] Documentation only

## Verification

<!-- Commands run and results. Add device details for manual checks. -->

- [ ] `bun run verify` passes
- [ ] New or changed behaviour has a test
- [ ] Manual device check (describe device, Android version, variant):
- [ ] Not applicable (docs only)

## Safety and failure modes

<!--
For protocol, crypto, AI, map, or SOS changes, answer:
- Which invariant is preserved?
- What happens with no fix, no pack, no radio, no model, or no network?
- Does this make any failure quieter without making it safer?
For docs-only changes, write "n/a".
-->

## Checklist

- [ ] Core logic stays in `src/core/` and platform I/O in `src/services/`
- [ ] No secrets, model weights, APKs, `dist/`, or generated build output
- [ ] Docs updated (`docs/`, and root `README.md` for user-visible changes)

## Screenshots / recordings

<!-- For UI changes. Remove personal data before attaching. -->
