## v12.8.3 — Responsiveness and startup fixes
- Catch failures in the entire message-processing path and send a visible diagnostic instead of only logging.
- Start the lightweight Render liveness endpoint before PostgreSQL migrations; `/ready` still reports whether Discord is connected.
- Honor per-call AI timeout values, including the shorter Council timeout.
- Prevent duplicate processing of the same Discord message and start typing feedback before model work.

# v12.8

- Added `/admin → AI & MODEL` screen that was missing from the v12.7 source.
- Added per-model enable/disable selection and bulk enable/disable for Motapis model rows.
- Added admin-only natural-language Discord management, with AI intent classification through configured Motapis model and deterministic fallback.
- Added guarded actions for channel/role management, slowmode/topic/lock, message purge, moderation (timeout/kick/ban/unban/nickname), moderation warnings, member/server info, channel/role listings and audit-log lookup.
- Destructive actions require explicit button confirmation bound to the requesting admin and expire after 2 minutes.
- Added PostgreSQL-backed moderation warning records with automatic table/index creation.
- Added required Server Members intent to support member lookup by name.
- Updated Render environment mapping and README setup guide.

## v12.8.1 — Render PostgreSQL migration fix
- Adds `ai_settings.updated_at` with an idempotent migration before any setting writes.
- Backfills missing timestamps in existing rows; preserves current settings and PostgreSQL data.

## v12.8.2 — Only /admin + ordinary chat
- Kept `/admin` as the only slash command registered by the bot.
- Removed natural-language moderation interception from the message pipeline so ordinary chat is routed to AI without requiring a mention.
- Preserved channel allow-list, AI routing, and optional council mode on mention/reply.
