# Bounded Chowdeck cache

MCP_STORAGE uses the existing Chowdeck D1 database. Account sessions, OAuth, order state and encryption remain in CHOWDECK_ACCOUNT Durable Object.

Initialize new deployments with hosting/d1-schema.sql. Cache entries are gzip-compressed, base64-encoded, and expire within 15 minutes. Cleanup runs every five minutes. SQL triggers enforce caps across concurrent instances: menus/general cache 32 MiB, 2,000 entries and 3,000 accepted puts/day; continuation cursors have a separate 4 MiB, 500-entry and 500-put/day reserve. UTC daily budgets persist across Worker restarts. Inserts, updates, accounting and cleanup consume physical D1 row writes, so accepted-put budgets deliberately leave room beneath the shared 100,000-row/day free limit. Cache misses fetch data normally; rejected continuation saves return an explicit error rather than an unusable cursor.

Values larger than 1.4 MB raw or 256 KiB compressed/base64 are not cached (continuations allow 512 KiB compressed/base64). Cache writes are optional for menu responses. An unusually broad search may require a fresh search after its continuation budget is exhausted. Daily reset is 01:00 Lagos time.

The old kv_entries table is legacy cache only and can be emptied after deployment; never delete or reset the CHOWDECK_ACCOUNT Durable Object. No KV binding or paid-plan upgrade is required.
