# Memento Mori Handbook

This handbook is for the person who operates and maintains Memento Mori. [README.md](README.md) introduces the project. `CLAUDE.md` is the document for AI assistants. The style is Simplified Technical English (ASD-STE100). Keep that style.

The repository is public. Do not put a secret value in a tracked file.

## Hosting locations

| Item | Where | Notes |
| --- | --- | --- |
| App, API, bot and jobs | Cloudflare Workers, name `memento-mori` | There is no custom domain. The address ends with `workers.dev`. The name is the address of the app and of the webhook. A new name gives a new address and a new Worker without secrets. |
| Staging app | Cloudflare Workers, name `memento-mori-staging` | Each pull request that changes `worker/` deploys here. It has no bot, no cron and no email job. The data is invented. |
| Staging database | Cloudflare D1, name `memento-mori-staging` | It holds `worker/seed.sql` only. Never put real data here. |
| Database | Cloudflare D1, name `memento-mori` | Region `apac`. The id is in `worker/wrangler.toml`. |
| Mail courier and backup | Google Apps Script | Open script.google.com, or use `npm run open`. The project id is in `.clasp.json`. There is no Web App deployment. |
| Backup file | Google Drive, owner account | One JSON file, rewritten each night. The job makes it on the first night and keeps the id in a script property. Drive keeps the earlier versions. |
| The bot | Telegram, made with **@BotFather** | |
| Gemini key | Google AI Studio | Free plan. |
| Share prices | Interactive Brokers Flex Web Service | See the maintenance task below. |
| Worker logs | Cloudflare dashboard, Workers, `memento-mori`, tab **Logs** | The setting `[observability]` in `worker/wrangler.toml` turns this on. It keeps the last days and it is searchable. `npm run tail` shows the present only. |
| Apps Script logs | script.google.com, tab **Executions** | The tab **Cloud logs** needs the standard Google Cloud project. See the task below. |
| Google Cloud project | console.cloud.google.com, owner account | A standard project, attached to Apps Script. The backup needs it, because `DriveApp` needs the Drive API. |
| Source code | GitHub, `akaNiknok/memento-mori` | `main` is the released code, and the only long-lived branch. |

## Settings that are not in the repository

A person sets each one in a browser. If you clone the repository, you do not get them.

### Cloudflare Worker secrets

Use `npx wrangler secret put <NAME>` in the `worker/` folder.

| Secret | Function |
| --- | --- |
| `APP_PASS` | The passphrase of the app. The cookie holds the SHA-256 hash and is valid for one year. If you change it, each device must sign in again. Use a long passphrase, because the login route does not limit the attempts. |
| `SECRET_TOKEN` | Telegram sends this value in a header. It must be the same as the script property `TELEGRAM_SECRET_TOKEN`. |
| `TELEGRAM_BOT_TOKEN` | The bot token from BotFather. |
| `TELEGRAM_USER_ID` | The only Telegram user that the bot answers. |
| `GEMINI_API_KEY` | The key from Google AI Studio. |
| `INGEST_TOKEN` | The Apps Script jobs send this value. It must be the same as the script property of the same name. |
| `IBKR_FLEX_TOKEN` | The token of the Flex Web Service. |
| `IBKR_FLEX_QUERY_ID` | The id of the Flex query. |
| `AI_READ_TOKEN` | Optional. An AI client sends this value to read the data through `/mcp`. It opens `/mcp` only, and it cannot write. The OAuth tokens for claude.ai are signed with a key from this value. If it is not set, `/mcp` and the OAuth routes are closed. Use a long random value. |

For `npx wrangler dev`, put the same names in `worker/.dev.vars`. Git ignores this file.

### Apps Script script properties

| Property | Function |
| --- | --- |
| `WORKER_URL` | The address of the Worker. Do not add a path and do not add a final slash. |
| `INGEST_TOKEN` | It must be the same as the Worker secret of the same name. |
| `GMAIL_HINTS` | Text for the parser about facts that the email does not state. Usually there is no such property, and the default text in `Gmail.gs` applies. |
| `GMAIL_QUERY` | It replaces the Gmail search. Usually there is no such property, and a value here has more authority than the label. |
| `GMAIL_LAST_TS`, `BACKUP_FILE_ID` | The code writes these values. Do not change them manually. |

### Settings in the database

The `meta` table holds the settings that were script properties before. Change them on the **Admin** screen of the app.

| Key | Function |
| --- | --- |
| `monthly_income_php` | The income that the percentage budget targets use. |
| `usd_php_fallback` | The exchange rate to use if the live rate is not available. |
| `fire_real_return` | The return each year, as a percent, after inflation. The Summary countdown uses it. |
| `owner_email` | It identifies the owner. |
| `widget_accounts` | The 3 accounts that the balance widget shows, as a JSON list of names. Set it on the screen **Admin**, card **iPhone balance widget**. |
| `smart_lists` | The saved filter sets of the screen **Activity**, as a JSON list of `{name, filters}` (20 maximum). Save and remove them on the screen **Activity**. |
| `tg_last_ids` | The code writes this value. Do not change it manually. |
| `prices_retry` | The code writes this value. It holds the 06:00 price failure until the 09:00 retry. Do not change it manually. |
| `app_url` | The address of the app. The code writes this value. The rescue cron reads it to build the Edit button. Do not change it manually. |

### Triggers and schedules

| Job | Where | Schedule |
| --- | --- | --- |
| `gmail_ingest` | Apps Script, add it manually | Each 5 minutes |
| `backup_run` | Apps Script, run `backup_install()` one time | Each day, approximately 03:00 |
| IBKR prices, then the net worth snapshot | Cloudflare cron, in `wrangler.toml` | 06:00 Manila time |
| The same job again, only if the 06:00 prices failed | A third Cloudflare cron, in `wrangler.toml` | 09:00 Manila time |
| Telegram message rescue | A second Cloudflare cron, in `wrangler.toml` | Each 2 minutes |

Cloudflare does not do a job again after a failure. Thus each job sends a Telegram message if it fails. Apps Script disables a trigger after a number of failures.

**Set the Apps Script failure notification.** Open the page **Triggers**, then the menu of the `gmail_ingest` trigger, then **Failure notification settings**, then **Notify me hourly**. Apps Script then sends one email each hour that has a failure. Without it, a failure is visible only on the page **Executions**. Do not use **Notify me immediately** for this trigger. It operates each 5 minutes, so a failure that continues sends 12 emails each hour. A late email causes no loss: a failed run does not move the watermark, and the next run reads the same mail again. A single "server error occurred" failure is a temporary Google fault. The next run corrects it.

**Attach a standard Google Cloud project.** This is necessary, not optional. The
backup writes a file with `DriveApp`, and `DriveApp` needs the **Google Drive API**
to be on. A default Apps Script project does not let you turn an API on, and the
backup fails with `Permission denied while enabling APIs: drive`. The same step
also fills the tab **Cloud logs**, which is empty on a default project.

Do these actions one time:

1. Open `console.cloud.google.com`. Make a project. Write down the project
   **number**, not the project id. Apps Script asks for the number.
2. In that project, open **APIs & Services**, then **OAuth consent screen**.
   Select **External**. Give an application name and your own email address.
3. **Set the publishing status to `In production`.** First complete the page
   **Branding**. Google does not publish without a homepage link and a privacy
   policy link. Give the address of this repository and of its `PRIVACY.md`, and
   add `github.com` under **Authorized domains**. Then open **Audience**, then
   **Publish app**, then **Confirm**. Do not start the verification. Ignore the
   banner "Your app requires verification" and the branding issues it lists. At the
   status `Testing`, Google cancels the permission after 7 days, and each
   trigger then fails with "Authorization is required to perform that action".
   An application that is not verified operates for a maximum of 100 users,
   and this script has one. The consent screen says the application is not
   verified: open **Advanced**, then **Go to (unsafe)**.
4. In that project, open **APIs & Services**, then **Library**. Enable
   **Google Drive API**.
5. In Apps Script, open **Project Settings**, then **Google Cloud Platform (GCP)
   Project**, then **Change project**. Give the project number from step 1.
6. The change of project cancels every permission. Open the editor, run
   `backup_run`, and accept the screen. Do the same for `gmail_ingest`.
7. Set the failure notification of the `backup_run` trigger to **Notify me
   immediately**. This trigger operates one time each night, so it sends a
   maximum of one email each day. Do not omit this. It is the only thing
   that makes a dead trigger visible. See the note below.
8. Examine the page **Executions** the next morning. The nightly backup must
   show **Completed**, and the file **Memento Mori Backup.json** must be in
   the Drive of the owner.

The script, the triggers and the script properties do not change. Only the
permissions change.


### Gmail, Telegram and IBKR

- **Apps Script permissions.** The project declares no `oauthScopes`, thus Apps Script calculates the list from the code at each push. A push that adds a `.gs` file or removes one changes that list, and each existing trigger then stops until a person runs a function in the editor one time and accepts the screen.
- **Gmail.** The courier searches for `in:inbox label:"Memento Mori"`. To add a bank or to remove a bank, change the Gmail filter that applies the label.
- **Telegram.** To set the webhook, use the Telegram `setWebhook` method with the address `<worker>/tg`, the secret token, and the update types `message` and `callback_query`. The buttons do not operate without `callback_query`.
- **IBKR.** In Client Portal, make a Flex Query that has the Open Positions section with the fields Symbol, Position, Mark Price and Currency. Enable the Flex Web Service, then make a token with the maximum validity.

### AI clients

The Worker gives an AI client read-only access at `<worker>/mcp`. The protocol is the Model Context Protocol (MCP). The client can read the summary, the accounts, the categories, the budgets, the investments, the debts and the transactions. It cannot write, delete or export the full database.

1. Make a long random value, for example with `openssl rand -hex 32`.
2. In `worker/`, run `npx wrangler secret put AI_READ_TOKEN` and paste the value.
3. Connect the client:
   - **Claude Code.** Run `claude mcp add --transport http memento-mori <worker>/mcp --header "Authorization: Bearer <value>"`. Do not add `--scope project`, because that scope writes the value into a file in the repository.
   - **Claude Desktop.** Add a server to `claude_desktop_config.json` with the command `npx`, the arguments `mcp-remote`, `<worker>/mcp`, `--header` and `Authorization:${AUTH}`, and the variable `AUTH` set to `Bearer <value>`.
   - **claude.ai, on the web and on the phone.** On the web, open Settings, then Connectors, then **Add custom connector**. Type the address `<worker>/mcp` and leave the OAuth fields empty. A page of the Worker asks for the app passphrase. Enter it, then select **Allow read-only access**. The connector then shows in the phone app too.
4. Examine the Claude privacy settings. The data goes to the AI provider.

Some transaction descriptions come from emails, and another person wrote that text. Use the connection in a session that has no tool that sends data out. Workers Logs in the Cloudflare dashboard keeps a record of each tool that the AI used. `npm run tail` shows the same record live. To stop all access, run `npx wrangler secret delete AI_READ_TOKEN`. This also cancels each claude.ai connection, because a new value makes every OAuth token invalid.

The claude.ai connection uses OAuth with no stored state. An access token is valid for 1 hour, and claude.ai gets a new one by itself. A refresh token is valid for 30 days after its last use. Each connection stops 90 days after you entered the passphrase, even with daily use. Then you connect again. The Worker sends a code only to a Claude callback address.

## iPhone widgets

The file `widgets/memento-mori.js` makes four home-screen widgets with the free app **Scriptable**. One script makes all four widgets. The widget parameter selects the widget.

| Widget | Size | Parameter | Content | A tap opens |
| --- | --- | --- | --- | --- |
| Recent | Small | `recent` | The 3 latest transactions. | Activity |
| Balances | Small | `balances` | The balances of 3 accounts. Select the accounts on the screen **Admin**, card **iPhone balance widget**. | Accounts |
| Net worth | Small | `networth` | The net worth, the change in 6 months and a line of the 6 months. | Summary |
| Segment targets | Medium | `segments` | Essentials + Rewards, Essentials and Rewards. Each has a bar and a mark for the date in the month. | Summary |

### Install the script

1. Install **Scriptable** from the App Store.
2. On the iPhone, open `widgets/memento-mori.js` on GitHub. Select **Raw** and copy all the text.
3. In Scriptable, select **+**. Paste the text. Set the name of the script to `Memento Mori`.
4. Run the script. Type the address of the app and the passphrase, then select **Sign in**.
5. Select a preview. Make sure that the widget shows data.

### Add a widget

1. Touch and hold the home screen. Select **Edit**, then **Add Widget**.
2. Select **Scriptable**. Select the small size or the medium size, then select **Add Widget**.
3. Touch and hold the new widget, then select **Edit Widget**.
4. Set **Script** to `Memento Mori`.
5. Set **Parameter** to a value from the table. If there is no parameter, a small widget shows `recent` and a medium widget shows `segments`.

### Widget notes

- The script keeps the session cookie in the iOS Keychain. It does not keep the passphrase.
- If `APP_PASS` changes, the widgets show "Signed out". Run the script in Scriptable and sign in again.
- iOS decides when a widget refreshes. The script asks for a refresh after 30 minutes.
- The four widgets share one request. A widget uses the data again if the data is less than 15 minutes old.
- If there is no connection, the widget shows the last data and the word "cached".
- To update the script, copy the new text over the old text in Scriptable. You do not sign in again.

## Maintenance tasks with a date

| Task | Interval | Result of a failure |
| --- | --- | --- |
| Make the IBKR Flex token again | Each year or sooner. The maximum validity is one year. | The price job fails and sends a Telegram message. The share values become old. |

## Routine tasks

```bash
npm run bootstrap        # make a fresh clone or a new worktree runnable
npm test                 # tests, no account necessary
npm run dev              # operate the app, the API and the bot locally
npm run dev:seed         # fill the local database with invented data
npm run migrate          # apply the pending database migrations
npm run tail             # read the live Worker log
npm run tail:staging     # read the staging Worker log
npm run push             # send the Apps Script files
```

### The staging app

A pull request into `main` deploys to a second Worker when it changes `worker/`. Each push to the pull request starts the Staging workflow, which applies the migrations, then deploys. Use the staging app to examine a change before you merge it. There is one staging app, so the last pull request that you pushed is the one that you see.

Staging is separate in every way that matters. It has its own database. It has no cron, so it never calls IBKR. It has no bot token and no email job. It needs one secret only:

```bash
cd worker && npx wrangler secret put APP_PASS --env staging
```

The database starts empty. Fill it from your computer:

```bash
npm run seed:staging
```

The seed is `worker/seed.sql`, which holds invented data. A normal push never reseeds, so your test data stays while you work. Use the same command again for a clean database. The Staging workflow can also do it: select **Run workflow**, then set **reseed** to true.

**Do not copy the real data into staging.** A second copy doubles the damage if a person learns the passphrase.

### Release procedure

1. Make a branch from `main`: `git switch -c feature/<name> --no-track origin/main`. Do the work on it.
2. Run `npm run release -- patch` or `npm run release -- minor`. The command changes the version, writes the number into `worker/public/index.html`, and commits. Then it tests the code, pushes the branch, and opens the pull request into `main`. **It does not deploy.**
3. Wait for the CI check. Then merge the pull request on GitHub.

A change that does not deploy (documents, tests, Apps Script) needs no new version. Open its pull request with `gh pr create --base main`. The CI check stops a pull request that changes `worker/` without a new version. The CI workflow tests each pull request. The `main` branch accepts only a pull request with a green check. Nobody approves the release a second time: your merge is the approval. You can also set auto-merge on the pull request. GitHub then merges it when the check becomes green, and the release starts without you.

The merge starts the Release workflow. The workflow applies the database migrations, deploys the Worker, makes the tag, and makes the GitHub release. A merge that does not change the version does nothing. GitHub deletes each merged branch. The Apps Script files are not part of this procedure. Send them with `npm run push` when you change them.

The workflow needs two GitHub repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Give the token the permissions **Workers Scripts:Edit** and **D1:Edit**, and no more. The token can read all of the financial data, because it can deploy a Worker that is bound to the database.

### Database migration procedure

Put each schema change in a new file in `worker/migrations/`, with a higher number. Do not change a file that was applied. Test with `npm run migrate:local`. The Release workflow applies it to the live database.

### How to undo a release

The code and the database do not go back together. Undo the code first.

1. Read the list of versions: `npx wrangler versions list`.
2. Put the last good version back: `npx wrangler rollback`.
3. Tell the repository what you did. Open an issue, or make the fix on a `fix/*` branch.

**A migration does not go back.** `npx wrangler d1 migrations apply` moves forward only. So an old Worker must still operate with the new schema. Never put a migration that removes or renames a column in the same release as the code that needs the change. Use two releases: the first adds, the second removes. If a migration destroys data, use D1 Time Travel below.

### How to recover the data

1. **D1 Time Travel.** It restores the database to a time in the last 7 days: `npx wrangler d1 time-travel restore memento-mori --timestamp=<ISO time>`.
2. **The backup file.** It holds every table as JSON, from the last night. Drive keeps the earlier versions of the file.
3. **The Admin screen.** Each table has an **Export CSV** button.

## Fault isolation

| Indication | What to examine, in this sequence |
| --- | --- |
| The bot sends no message at all. | **Wait 4 minutes first.** Since v2.12.0 a cron re-runs a turn that died, thus a late receipt is normal and the message is not lost. If nothing arrives, read `getWebhookInfo`, after you send a new test message. Do not set the webhook again first, because that action erases the last error. An error there means that the message did not arrive. A 403 points to the secret `SECRET_TOKEN`, which must be the same as the script property `TELEGRAM_SECRET_TOKEN`. If the webhook is clean, run `npm run tail` and send a message. A slow parse sends "Still working" and continues. |
| The bot answers late, or the same message arrives twice. | The rescue cron did the turn again. Read `npm run tail` for the line `rescuing update`. A second receipt says "Already logged", thus no transaction is double. If every message is late, the first turn always fails: examine the Gemini quota. |
| The bot answers, but the answer is an error. | `npm run tail` while you send a message. Then the Gemini quota in AI Studio. An answer of "Unauthorized" indicates the secret `TELEGRAM_USER_ID`. |
| The buttons do not operate. | Set the webhook again. The permitted update types do not include `callback_query`. |
| An email stays in the inbox, and the transaction is absent. | The courier tries a failed email again for 3 hours, thus wait 10 minutes first. Then read the Worker logs for the line `ingestEmail:`. A message there names the cause, and it is usually the Gemini quota. To make the courier read the email again after that, delete the script property `GMAIL_LAST_TS`. The row identifier is deterministic, thus a transaction that is already recorded does not become double. |
| The backup fails with "Permission denied while enabling APIs: drive". | Apps Script tried to enable the **Google Drive API** and it has no permission. This happens on a default Apps Script project, which does not let a person enable an API. Attach a standard Google Cloud project and enable the Drive API there. The task above gives each action. |
| A trigger fails with "Authorization is required to perform that action." | There are two causes. ① The consent screen of the Google Cloud project is at the status `Testing`, and Google cancels the permission each 7 days. Set it to `In production` (step 3 of the task above). ② `npm run push` changed which files the Apps Script project holds, thus Apps Script calculated the list of permissions again. For both causes, the repair ends with one action: open the editor, select `gmail_ingest`, press **Run**, then accept the screen. Do the same for `backup_run`. The triggers operate again at the next tick. |
| The job does not record the emails. | The Gmail filter. Then the property `GMAIL_QUERY`, which replaces the label. Then the trigger, because Apps Script can disable it. Then the property `WORKER_URL` and the two `INGEST_TOKEN` values. |
| The staging deploy fails. | The value `database_id` in the `[[env.staging.d1_databases]]` block of `worker/wrangler.toml`. A new checkout has a placeholder there. Make the database with `npx wrangler d1 create memento-mori-staging --location=apac`, then write the id into the file. |
| The pull request does not merge. | The CI check on the pull request. Read the log of the failed job. The `main` branch accepts no merge before the check is green. |
| The AI client gets `401` from `/mcp`. | The client sends a value that is not the same as the secret `AI_READ_TOKEN`, or the secret is not set. The app passphrase and `INGEST_TOKEN` do not open `/mcp`. |
| claude.ai cannot add the connector, or it shows "invalid_redirect_uri". | Claude sent a callback address that the Worker does not know. The list of addresses is `CALLBACKS` in `worker/src/oauth.js`. Add the new address with a test. |
| The claude.ai connector stops after 30 days with no use, or 90 days after you connected. | The refresh token expired, or the 90-day limit ended the connection. Connect again from the connector settings. |
| The app asks for the passphrase frequently. | A person changed `APP_PASS`, or the cookie is more than one year old. |
| The app shows "Storage is full" and does not save the entry. | The device has no free space for the offline queue. The app deletes the cached screens first, then makes a second attempt. This message means that the second attempt also failed. Delete files on the device. Then enter the transaction again, because the app did not record it. |
| The app starts, but each request fails. | `npm run tail`. Usually the D1 binding or a secret is absent. |
| The bot sends the message "share count drift". | The count of shares in the ledger does not agree with the count at IBKR. Examine a corporate action first, for example a split of shares. For a split, multiply the quantity of shares in each earlier transfer leg. Change the field **ToAmount** on a purchase. Change the field **Amount** on a sale. Change a leg before the effective date only. Then examine a trade that nobody recorded. The job does not write the count from IBKR, because that action hides the cause. |
| The price job says "blocked before IBKR answered". | An edge between the Worker and IBKR refused the request. IBKR never saw it, so no token and no query is at fault. The reply body names the edge, for example "403 error code: 1000" or "530 error code: 1016". The job tries again at 09:00 by itself. You get this message only when the 06:00 and 09:00 tries both fail. Do nothing the first time. Examine the IBKR system status page if the message arrives on two days. |
| The share values are 0 or absent. | The Telegram message from the price job. It names the IBKR error code, and it states the repair for a code that needs a person. A code that IBKR clears by itself is retried for 40 seconds first, so one message is one real fault. Then the `symbol` column of the account on the Admin screen. |
| A balance in pesos is absent, but the native balance is correct. | The exchange rate. Examine `usd_php_fallback` in the `meta` table. |
| A change is not in the live system. | Nobody merged the release pull request. `npm run release` only opens it. The merge into `main` deploys. |

**Free plan limits.** Cloudflare permits 100 000 Worker requests each day, 5 GB in D1, 5 million read rows and 100 000 written rows each day, and 5 cron triggers. The static files do not count. Apps Script gives approximately 90 minutes of trigger time each day, and the mail courier uses 6 to 10 percent. Gemini has a limit for each key.

## How to build the system again

1. Make the D1 database: `npx wrangler d1 create memento-mori --location=apac`. Put the id in `worker/wrangler.toml`.
2. Apply the schema: `npm run migrate`.
3. Set each Worker secret, then run `npm run deploy`.
4. Make the bot with BotFather, then set the webhook to `<worker>/tg`.
5. Make the Gmail label and the Gmail filter.
6. Make an Apps Script project. Run `clasp login`, then put the script id in `.clasp.json`. Enable the Apps Script API one time at script.google.com/home/usersettings. The first push fails without it. Run `npm run push`. Set the script properties. Add the `gmail_ingest` trigger, then run `backup_install()`. Set the failure notification of `gmail_ingest` to **Notify me hourly** and of `backup_run` to **Notify me immediately**.
7. Make the IBKR Flex query and token.
8. Open the app, then put the accounts, the categories and the budgets in the **Admin** screen.

## The files

```
worker/worker.js       the entry: /tg, /api, /login, the cron dispatch and the route tables
worker/src/            db · api · telegram · gemini · fx · jobs
worker/migrations/     the SQL schema, one numbered file for each change
worker/public/         the app: index.html, app.css, app.js, sw.js, icons, manifest
Gmail.gs, Backup.gs    Apps Script: the mail courier and the nightly backup
Tests.gs               the tests of the Apps Script helpers
migrate/backfill-nw.js the one-time rebuild of the net worth history
release.js             it tests the code and opens the release pull request
test.js, test-api.js   the Node programs that do the tests
bootstrap.js           it makes a fresh clone or a new worktree runnable
icons.js               it makes the icons again from an SVG file
CLAUDE.md              the document for AI assistants
MEMORY.md              the record of the decisions and the reasons for them
```

Git ignores `.clasprc.json` (the clasp credentials) and `worker/.dev.vars`. You cannot recover them from the repository.
