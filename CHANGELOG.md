# v12.8

- Added `/admin → AI & MODEL` screen that was missing from the v12.7 source.
- Added per-model enable/disable selection and bulk enable/disable for Motapis model rows.
- Added admin-only natural-language Discord management, with AI intent classification through configured Motapis model and deterministic fallback.
- Added guarded actions for channel/role management, slowmode/topic/lock, message purge, moderation (timeout/kick/ban/unban/nickname), moderation warnings, member/server info, channel/role listings and audit-log lookup.
- Destructive actions require explicit button confirmation bound to the requesting admin and expire after 2 minutes.
- Added PostgreSQL-backed moderation warning records with automatic table/index creation.
- Added required Server Members intent to support member lookup by name.
- Updated Render environment mapping and README setup guide.
