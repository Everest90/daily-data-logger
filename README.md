# Daily Data Logger

A responsive, offline-first React app for multi-item daily handoffs. Existing entry, search, filters, history, reminders, themes, and backup workflows remain in place. Records now use IndexedDB; optional team workspaces sync through Supabase.

The Today view offers Quick entry and Full entry modes. Quick entry defaults to Powerbank / None and includes a custom item field when Others is selected. Daily overview and each history date show item counts by type. Depositor names are required; labels are optional whole numbers from 1 to 10000. A label remains unavailable for new entries while any earlier entry using it has pending items. Payment can be changed directly from record lists, completed entries show their completion time, and up to five entries can be pinned to the top of matching search results on this device. Notifications dismiss after five seconds. Check-in is no longer shown; older saved check-in values remain stored for compatibility. Existing entries can be edited directly in the Today or history record list.

## Uploading the project to GitHub safely

The `.gitignore` rules exclude installed packages, generated builds, browser-test artifacts, local environment files, and common operating-system files. Keep these project files in GitHub because they are required to build or deploy the app: `src/`, `public/`, `supabase/migrations/`, `supabase/functions/`, `supabase/config.toml`, `package.json`, `package-lock.json`, the Vite/TypeScript configuration, this README, and `.env.example`.

The checked-in [`.env.example`](./.env.example) contains placeholder values only. Create `.env.local` on your computer for real development settings; `.env.local` and other `.env.*` files are ignored. Before the first push, inspect the staged file list and diff, and confirm no `.env` file, workspace access code, database password, service-role key, function pepper, or backup containing real records is staged.

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (or the newer publishable key) are public browser configuration; they are not service credentials and the app can use them to connect to Supabase. Prefer configuring them in your deployment host's build environment rather than hardcoding personal project values in source. The service-role key and `WORKSPACE_CODE_PEPPER` are private server secrets: keep them only in Supabase Edge Function Secrets. Never put either in a `VITE_` variable. The workspace access code and exported data backups should also not be committed.

If GitHub Pages or another GitHub-based host is configured later, its build needs the two public `VITE_` variables. The Supabase function secrets remain configured in Supabase, not in the static website build. Review repository visibility before pushing: a public repository exposes all committed source and history.

## Run locally

```sh
npm install
npm run dev
```

Use `npm run typecheck` and `npm run build` to validate the app. A successful production build writes the installable app shell and service worker to `dist/`.

On first launch, existing valid `daily-data-logger.records.v1` localStorage records are migrated to IndexedDB. Theme preference and the Supabase anonymous device session remain in localStorage. Browser storage can still be cleared by the user or browser, so download JSON backups regularly.

## Offline and installable use

- Deploy over HTTPS (localhost is also a secure context) and open the app online once so its service worker can cache the app shell.
- Install from the browser's install action where available. On supported browsers, an **Install app** button appears in the header.
- Records are written to IndexedDB on this device first. When a connected workspace is in use, queued changes sync when the app is online and open; the app also retries on reconnect and periodically while open.
- The service worker does not run the app's sync logic while the app is closed. Open the app to send queued changes.

## Database and workspace setup (Supabase)

The app has two kinds of storage:

- **Local device mode** stores records in the browser's IndexedDB. It works without Supabase and does not send records to a server.
- **Workspace mode** uses Supabase Postgres as the shared team database. Records are still saved to IndexedDB first, then queued and synchronized while the app is open and online.

Supabase is optional. The frontend is a static app; Supabase is only the database/authentication/Edge Function service for shared workspaces, not an app server.

### 1. Create and configure the Supabase project

1. Create a project in Supabase and save its database password somewhere secure.
2. In **Project Settings → API**, copy the Project URL and the public `anon`/publishable key.
3. In **Authentication → Providers**, enable **Anonymous Sign-Ins**. The app uses anonymous Supabase identities per browser/device; no email account is requested.
4. Apply the SQL migrations in `supabase/migrations` in filename order:
   - [`202611050001_daily_data_logger.sql`](./supabase/migrations/202611050001_daily_data_logger.sql)
   - [`202611110001_optional_numeric_labels.sql`](./supabase/migrations/202611110001_optional_numeric_labels.sql)

   For a manual setup, open **SQL Editor**, paste and run the first file, then paste and run the second. For CLI setup, from this project directory run:

   ```sh
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   ```

   The project ref is in the Supabase project's URL or **Project Settings → General**. `db push` applies the migrations in this repository.

### 2. Configure and deploy the workspace access function

The `workspace-access` Edge Function creates or joins a workspace and authorizes the current anonymous device. In **Edge Functions → Secrets**, set these server-side secrets:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | This project's Supabase URL |
| `SUPABASE_ANON_KEY` | This project's public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | This project's service-role/secret key |
| `WORKSPACE_CODE_PEPPER` | A private random string with at least 32 bytes of entropy |

Generate a pepper locally (for example, `openssl rand -hex 32`). Keep it in the Supabase function secrets only; do not commit it, put it in `.env.local`, or expose it in the website host settings. The service-role key bypasses database row-level security, so it must also remain a server-side secret.

Install the Supabase CLI if needed, then from this project directory run:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy workspace-access
```

The CLI uses `supabase/config.toml` to deploy the function. Deploy the migrations and set the function secrets before testing workspace creation or join.

### 3. Connect the frontend to Supabase

For local development, create `.env.local` in the project root using `.env.example` as a template:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
```

Then restart the Vite process and run `npm run dev`. Vite reads `VITE_` variables at build time. For deployment, configure those same two values as **build environment variables** in the static host and trigger a new build/deployment after changing them.

The Project URL and anon/publishable key are public client configuration and will be included in the frontend bundle. This is expected: row-level security and the workspace access function enforce access. Never put `SUPABASE_SERVICE_ROLE_KEY` or `WORKSPACE_CODE_PEPPER` in a `VITE_` variable or frontend host setting.

### 4. Create a workspace and connect devices

1. Open the deployed app and select **Connect workspace**.
2. On the first device, choose **Create workspace**, provide a workspace name, and choose a strong, unique access code (at least 12 characters). Store it in a trusted password manager.
3. On each additional device, open the same deployed site, choose **Join workspace**, and enter that exact access code.
4. To upload records that already exist in local device mode, switch to the workspace and explicitly choose **Copy local records to workspace**. The app does not upload local records automatically; local originals are retained.
5. To return to device-only data, switch back to **Local device**. Local and workspace records are separate datasets.

The access code acts as a shared bearer credential: every person who knows it can read, add, edit, and delete workspace records. There are no individual team accounts, roles, or per-record permissions. Share it only with trusted team members. If it is exposed, create a replacement workspace/code and have devices re-authorize. If a device is lost, revoke its membership by setting its row's `revoked_at` in Supabase's `workspace_devices` table.

The migrations enable row-level security; workspace reads require an authorized device, and writes use a version-checked database function. If two devices edit the same record before syncing, the app reports a conflict and asks whether to **Use shared version** or **Keep my version**. Pending changes remain queued on the device until synchronization succeeds.

## Deploy and install

This is a static Vite site; no Node server process is needed in production. Use Node.js 20.19+ (or 22.12+) to build it.

1. In the static hosting provider, select this project folder as the root directory.
2. Set the build command to `npm run build` and the output/publish directory to `dist`. The lockfile is `package-lock.json`; hosts should use `npm ci` for a reproducible install.
3. If enabling shared workspaces, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the host's build environment. Do **not** add the service-role key or pepper there.
4. Deploy over HTTPS. The HTTPS origin is needed for service-worker/PWA installation and offline shell caching. If the host publishes this app below a URL subpath rather than at the domain root, configure Vite's `base` path to match before building.
5. Open the live URL online at least once on each phone/computer. Use the browser's install action or **Add to Home Screen** where supported. Then connect each device to the workspace as described above.

For Vercel, use the Vite preset, set the root directory to this project, set the output directory to `dist`, add the public `VITE_` values if using Supabase, and redeploy. Other static hosts can use the same build command and output directory.

To check a production build locally, run:

```sh
npm ci
npm run typecheck
npm run build
npm run preview
```

The app saves and queues workspace changes on-device first. The service worker caches the app shell but does not run workspace synchronization while the app is closed; reopen the app online and use **Sync now** (or wait for automatic retry) to send queued changes. Keep using **Download backup** independently of workspace sync. Workspace backups/PDFs are device snapshots; wait for **All changes synced** before relying on them as a complete team-wide view.

## Storage, restore, and reports

- **Download backup** exports the current local or workspace view as validated JSON. Restore is available in Local device mode and replaces only local records; it does not overwrite shared workspace data.
- Workspace PDFs identify a local copy when offline or when there are unsynced changes. Run **Sync now** and wait for **All changes synced** before relying on a team-wide report.
- Today's and all-records reports download structured PDFs with itemized details and page numbers.
- Deletions can be undone immediately. Shared deletions are queued and synced like other changes.
- Changing browser/device or clearing site data removes that device's local IndexedDB data. Use JSON backups for an independent copy.
