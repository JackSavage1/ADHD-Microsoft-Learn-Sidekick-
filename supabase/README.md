# Sidekick cloud sync (Supabase)

Cloud sync keeps a learner's progress in a Supabase Postgres database, so any computer with their **sync code** can pick up where they left off. There is no server code: the whole backend is one SQL file, [`migrations/20261026210000_sidekick_sync.sql`](migrations/20261026210000_sidekick_sync.sql).

```
 Sidekick panel ── POST /rest/v1/rpc/<function> ──▶ Supabase API ──▶ 4 SQL functions ──▶ 2 locked tables
                   headers: apikey (publishable key)                 (security definer)    (RLS, no policies)
                   body: { p_code, ... }
```

## What's in the database

| Object | Purpose |
| --- | --- |
| `sidekick_accounts` | One row per sync code. Stores only `sha256(code)`, never the code. |
| `sidekick_progress` | One row per account: the progress snapshot (JSON), a `version` number, `updated_at`. |
| `sidekick_private` schema | Helpers: normalize a code, hash it, find its account. Not reachable through the API. |
| 4 public functions | The only API. Each checks the sync code first. |

## The API

Every function is called as `POST https://<project>.supabase.co/rest/v1/rpc/<name>` with the header `apikey: <publishable key>` and a JSON body. Every answer is JSON with a `status`.

| Function | Body | Answers |
| --- | --- | --- |
| `sidekick_create_account` | `{}` | `{ status: "ok", code: "K7QX2-MPD4R-9TBWN-3HCVE" }`, or `busy` |
| `sidekick_get_progress` | `{ p_code }` | `{ status: "ok", data, version, updatedAt }` (a new account has `data: null`, `version: 0`), or `unknown_code` |
| `sidekick_put_progress` | `{ p_code, p_data, p_base_version }` | `{ status: "ok", version, updatedAt }`, or `conflict` with the current `data` and `version`, `unknown_code`, `invalid`, `too_large` |
| `sidekick_delete_account` | `{ p_code }` | `{ status: "ok" }`, or `unknown_code` |

## How saving stays correct with two computers

Each save says which version it's based on (`p_base_version`). The function writes only if that's still the current version, with the check and the write in a single SQL statement, so two computers saving at the same moment can't both win. The loser gets `conflict` with the current copy. The panel merges it (keeping finished steps, quiz answers and sessions from both) and saves again. The panel side is in `panel.js`, section 13.

## Security choices

- **Locked tables:** row level security is on with no policies, and the `anon` and `authenticated` roles have no table privileges. Nobody can read or write the tables directly through the API.
- **Four functions are the only way in.** They run as `security definer` with an empty `search_path`, so they can use the locked tables and can't be tricked into using look-alike objects.
- **No passwords or emails.** The database generates each sync code from 20 random bytes in Crockford base32 (about 100 bits), returns it once, and stores only its SHA-256 hash. Codes are forgiving to type: case, dashes, and O, I or L in place of 0, 1 or 1 don't matter.
- **The publishable key can live in the extension.** All it allows is calling the four functions.
- **Limits:** progress up to 256 KB per account, and at most 30 new accounts per minute across everyone (a spam brake).
- **Delete my cloud data** removes the account and its progress (`on delete cascade`).

## Set it up in a Supabase project

1. In the Supabase dashboard, open your project, then **SQL Editor**, then **New query**.
2. Paste the whole migration file and click **Run**.
3. Run the **Security Advisor** (Advisors, then Security Advisor). It may point out that the four functions are callable by `anon` with `security definer`. That's intended: they are the API.
4. In `panel.js`, set `SYNC_URL` to the project URL (Project Settings, then API) and `SYNC_KEY` to its **publishable** key, then reload the extension.

Or, with the Supabase CLI: `supabase link --project-ref <ref>`, then `supabase db push`.

## Try it by hand

```bash
URL=https://<project>.supabase.co
KEY=sb_publishable_...
curl -s -X POST "$URL/rest/v1/rpc/sidekick_create_account" -H "apikey: $KEY" -H "Content-Type: application/json" -d '{}'
curl -s -X POST "$URL/rest/v1/rpc/sidekick_get_progress"   -H "apikey: $KEY" -H "Content-Type: application/json" -d '{"p_code":"<your code>"}'
```
