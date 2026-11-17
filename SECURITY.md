# Security policy

KindMinds Kit handles location, SOS messages, and private text in environments
where networks are untrusted or absent. Reports about the mesh, data storage, or
AI safety behaviour are welcome.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.x` (current) | yes |
| Older snapshots | no |

Only builds from the current `main` branch are supported. Include the commit or
release tag in a report.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the issue, affected version/commit, and reproduction steps.

If private reporting is unavailable, contact the repository owner through their
GitHub profile and ask for a private channel. Do not include exploit details in a
public issue, discussion, or pull request.

Please include:

- affected component (mesh protocol, crypto, storage, AI validation, build),
- a minimal reproduction or proof of concept,
- impact and who is exposed,
- whether the issue is already public.

Do not attach real user data, location traces, private messages, or model files.

## Scope

In scope:

- mesh packet parsing, fragmentation, relay policy, and replay handling,
- identity, key derivation, sealing, and safety-number behaviour,
- data persistence and unintended network transmission,
- authentication/authorization gaps in the Android native modules,
- AI output that bypasses the grounding or unsafe-advice checks,
- path traversal or unsafe file handling for received files and imported packs,
- dependency vulnerabilities with a demonstrated impact.

Out of scope or accepted limitations (documented, not vulnerabilities by
themselves):

- broadcast room/SOS/file traffic being readable by anyone in range,
- absence of forward secrecy and automatic DM key exchange,
- unsigned announcements allowing callsign spoofing,
- metadata exposure (who talked to whom, timing, size),
- BLE jamming, denial of service by radio noise, or battery exhaustion,
- data at rest on a rooted or compromised device (no keystore wrapping yet),
- the debug keystore used for the template release build,
- the public Nominatim/OSRM/Esri endpoints and their availability.

If you believe one of these limitations is worse than documented, report it
privately and explain the concrete impact.

## Response

The maintainers will acknowledge a report, investigate, and coordinate a fix and
disclosure. Please allow time for a release before publishing details. Credit is
given on request.

## Hardening checklist for deployments

- Build with your own release keystore.
- Point the map tile URL at an authorised or self-hosted server.
- Mirror model files if Hugging Face access is not acceptable.
- Consider `android:allowBackup="false"` for shared or high-risk devices.
- Treat the mesh as a public broadcast medium; do not send secrets in rooms.
