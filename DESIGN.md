# DESIGN.md
The design system of the Memento Mori PWA (v3). Read it before you add or change anything the user sees. `worker/public/app.css` holds the tokens. This file holds the rules for using them. If the two disagree, fix one of them in the same commit.

## Principles
Apple's HIG principles (hierarchy, harmony, consistency), applied to one goal: **less effort to keep the books.**
1. **One answer first.** Each screen leads with the one number that answers its question. On Summary that number is "Left to spend". Everything else is secondary.
2. **One line to add.** You can reach the type-to-add field from every screen. A form is the fallback, not the default.
3. **Edit where you read.** Change a value in place. Do not add a Save step when the change can be undone.
4. **One app on three devices.** iPhone, iPad and PC show the same tiles in the same order. Only the columns and the navigation change. Every action works with touch and with a mouse.
5. **Explain every derived number.** A figure that the app calculates gets an ⓘ tooltip. The tooltip shows the formula with the live inputs.
6. **Calm by default.** Colour carries meaning, not decoration. A transaction amount is coloured by its direction; every other figure is plain text unless it is a state.

## Colour
Tokens live on `:root` in `app.css`. Light is the default. `[data-theme=dark]` and `prefers-color-scheme: dark` (when the theme is Auto) switch to dark.
| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#F2F2F7` | `#000000` | Page ground |
| `--card` | `#FFFFFF` | `#1C1C1E` | Tiles, lists, sheets |
| `--card-2` | `#E4E4EA` | `#2C2C2E` | Fields, segmented tracks, secondary fills |
| `--card-3` | `#D8D8DE` | `#3A3A3C` | Hover and pressed state of a `--card-2` fill, scrollbar thumb |
| `--text` | `#1C1C1E` | `#F5F5F7` | Primary text and amounts |
| `--dim` | `#6C6C70` | `#A1A1A6` | Secondary text. It passes 4.5:1 on `--card`. There is no lighter text grey. |
| `--sep` | `#E5E5EA` | `#38383A` | Hairlines between rows |
| `--track` | `#E9E9EE` | `#2C2C2E` | Empty part of a bar or meter |
| `--accent` | `#2463EB` | `#0A84FF` | Actions, selection, focus and links only. Also the liquid net-worth series. |
| `--pos` | `#157A50` | `#30D158` | Income amounts, "on track" states |
| `--neg` | `#C4382D` | `#FF453A` | Errors, destructive actions, liabilities, over budget, expense amounts |
| `--warn` | `#B45309` | `#FF9F0A` | Due soon, needs review, limit reached |
| `--ess` | `#0E7C86` | `#64D2FF` | Essentials segment |
| `--rew` | `#D97706` | `#FF9F0A` | Rewards segment |
| `--gro` | `#7C5CFA` | `#BF5AF2` | Growth segment and the invested series |
| `--chart-in` / `--chart-out` | `#1F9D6B` / `#D95757` | `#30D158` / `#FF453A` | Cash-flow bars |
| `--tip` | `#1C1C1E` | `#3A3A3C` | Tooltip, toast, chart tooltip and bulk-bar background (text on it is always `#F5F5F7`) |
| `--side` / `--side-sel` | `#ECECF0` / `#DCDCE3` | `#111113` / `#2C2C2E` | Sidebar and rail ground / selected nav item |
| `--bar` | `rgba(249,249,251,.94)` | `rgba(18,18,20,.94)` | Tab bar (blurred) |
Each semantic token also has a `-tint` variant: a 12–18% wash for chip and icon-tile backgrounds. `app.css` derives it with `color-mix()`, so a tint follows its theme with no second value.
Rules:
- **Amounts.** In a transaction row (list, table, Recent tile): an expense is `--neg` with a "−". Income (and a refund) is `--pos` with a "+". A transfer is `--accent` with no sign, the same as its ⇄ tile. Totals and nets (day headers, result line, bulk bar) stay plain text. The owner chose coloured row amounts on 2026-09-19; the sign still carries the direction for a CVD reader.
- **Colour is never the only channel.** In/out bars keep a fixed position (in left, out right) and a legend. A status also has a word ("Limit reached", "Funded ✓").
- **Check chart colours** against `--card` for 3:1 contrast in both themes when a series colour changes. The Scriptable widgets (`widgets/memento-mori.js`) copy these tokens, so change them in the same commit.
- **Account colours** (`accounts.color`) appear only as the dot or initial tile of that account.

## Typography
- **System font stack**: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`. There are no web fonts, so nothing downloads and the text works offline. The ₱ glyph is in SF and Segoe UI.
- **`font-variant-numeric: tabular-nums`** on everything that shows money, so the digits line up in columns.
| Role | Size / weight | Where |
| --- | --- | --- |
| Large title | 34 / 700, −0.5 tracking | Screen title on iPhone and iPad |
| Title | 26 / 700 | Screen title in the PC toolbar |
| Hero figure | 38–44 / 700, −1 tracking | The one answer on a screen (net worth, "They send you") |
| Tile figure | 26–30 / 700 | Tile values |
| Headline | 17 / 600 | Row titles that need weight |
| Body | 17 phone, 15 iPad, 14 PC / 400 | Rows, fields |
| Label | 13 / 600, `--dim` | Tile and section labels, **sentence case, never all caps** |
| Footnote | 12–13 / 400, `--dim` | Metadata, captions |
- **Input text is never under 16px on touch devices**, or iOS zooms the page when you tap the field.
- Copy follows the owner's Simplified Technical English rules: sentence case, active voice, short labels. Put the unit in the value ("5.2 months", "₱1,745 a day").

## Shape, space, depth
Radius: tile 20, list group 16, field and button 12, chip 999 (pill), icon tile 9–10. Spacing is a 4px scale. Tiles use 16px gaps. Tile padding is 16–20px. Pages have a 16px gutter on iPhone and 24–28px on iPad and PC. **Depth is for things that float**: only sheets, popovers, tooltips, the bulk bar and the add bar get a shadow. Tiles are flat.

## Layout
- **Breakpoints and navigation**:
  - under 768px (iPhone): tab bar (Summary, Activity, Accounts, More), with the add bar docked above it
  - 768–1199px (iPad portrait, small windows): 76px icon rail, with the add field in the page header
  - 1200px and wider (iPad landscape, PC): 240px sidebar, with the add field in the toolbar
- The sidebar and the rail carry "Synced just now" (or the offline or queued state) and the light/dark button.
- **Tile grid**: 4 columns on PC, 2 on iPad, 1 on iPhone (small tiles pair up in 2). A tile has a fixed span per breakpoint. Summary uses a grid because its rows are designed. Long list screens keep the two-column multicol layout (see the `spa-frontend` skill), because a grid row is as tall as its tallest card.
- **Scrolling**: the v1.6.5 app shell stays. `.main` is the only scroller, and `--app-h` sizes the shell. Floating bars sit inside `#app`, not on `body`. They respect `env(safe-area-inset-*)`.
- Screen keys inside the code stay `dashboard` and `transactions`, because deep links and the Telegram receipt use them. Only the labels become Summary and Activity.

## Components
- **Tile**: `--card`, radius 20, a 13/600 `--dim` label on top, then the figure, then one footnote line. A tile that the app calculates gets an ⓘ button in the label row.
- **Grouped list**: rows of at least 44px (56–60 on iPhone) with a hairline inset past the icon. Row layout, left to right: icon tile (tinted), title and subtitle, value, chevron (only when the row opens something).
- **Segmented control**: `--card-2` track with the selected segment on `--card`. Use it for 2–4 exclusive options (Spent / Earned / Moved, 6M / 1Y / 2Y).
- **Chip or token**: pill, 28–36px tall. A filter token is `--accent-tint` with `--accent` text and an × to remove it. The field label ("Account", "Amount") sits inside the pill at 80% opacity.
- **Transaction row**: the icon tile carries the first letter of the title, tinted by segment (`--ess`, `--rew`, `--gro`); income is `--pos`, a transfer is `--accent` with ⇄, anything else `--card-2`. On a phone, rows group under day headers, one card per day, a left swipe shows Delete, and a right swipe enters Select mode with that row picked (a tap already opens the edit view). From 1200px, Activity shows the same rows as a table (Date, Description, Category, Account, Amount) beside a filter pane (smart lists, then the accounts with balances).
- **Tooltip (ⓘ)**: one component for mouse and touch. It opens on hover and focus on a pointer device, and on a tap on the ⓘ on touch. Esc or a tap outside closes it. Content, in order: a title that is a plain question or answer, one sentence on what the number means, the formula as rows with live values (the result rows in bold), then what the figure leaves out, then at most one link to the source (underlined, in the tooltip text colour; it opens a new tab). Keep it under 360px wide.
- **Editor** (add and edit a transaction or transfer): a full-screen page on iPhone that slides in from the right; a centred form sheet (540px wide, backdrop) from 768px. Top bar: Cancel / title / Save. Content is iOS grouped rows (label left, value right, 17px): Amount (22px, ± key, the account's currency) and Description first so a text field never sits under the keyboard, then Category, Account (From/To), Date. Reports in, Exchange rate and To amount stay behind "More options" unless set. Delete is a red row at the bottom. A pick row pushes a picker page (Back, a search field for lists over 8, a tick on the current value). Nothing resizes for the keyboard; its height only pads the bottom. Other forms keep the plain modal.
- **Bottom sheet** (iPhone and iPad): grab handle, Reset / title / Done header, primary button at the bottom. On PC the same content opens as a popover or a side panel.
- **Bulk bar**: floating `--tip` pill at the bottom centre. It shows "N selected · total", then the actions, with Delete last in `--neg`.
- **Add bar**: one field for "add, search or jump". On iPhone it is docked above the tab bar with a + (the full form; iOS dictation is the mic). On iPad and PC it sits in the header with a ⌘K / Ctrl K hint. A tap or typing opens the **quick-add panel**: on iPhone a full-screen page (Cancel / Add bar on top, the field at the bottom, right on the keyboard), from 768px a 520px dropdown under the field. It holds Spent / Earned / Moved, the amount (coloured like a row amount), the description, then Category, Account (From/To) and Date rows (a tap opens the editor's picker page), then "Or repeat one" chips. Text with no amount lists "Go to <screen>" and "Search Activity" rows; ↑ ↓ pick one, Return runs it. Return on a whole draft saves; on a partial one it asks the parser once, then opens the full form with the fields filled.
- **Banner**: a `--warn-tint` strip, radius 16, with the info icon, one bold sentence, the detail, and one `--warn` pill button on the right. Use it for something to act on that is not an error ("1 salary is not in the tax ledger").
- **Typed cell** (a table cell you must fill in by hand, like the BSP rate): a `--card-2` field, radius 8, inside the cell. An empty one reads "Type" in `--dim`. A locked column carries the lock icon in its header.
- **Range bar** (Swap): a 12px bar from `--pos` to `--accent` between two labelled ends, a 3px `--text` mark for the result with its label under it, and a thin white mark for the reference value.
- **Pager**: "1–50 of 312", then Previous and Next as link buttons, at the end of the list. Activity and Admin share it.
- **Consent page** (`/authorize`, served by `worker/src/oauth.js`, not the SPA): one centred `--card` tile, max 360px, on `--bg`. Headline, one `--dim` sentence on what access it grants, a Label over a `--card-2` password field (17px), the error line in `--neg`, then one full-width `--accent` button. It copies the tokens inline because it cannot load the SPA shell; change them there too when a token changes.
- **Icons**: one inline SVG set (`<symbol>` sprite in `index.html`, used with `<use href="#i-name">`). Specs: 24px grid, 1.9 stroke, round caps and joins, `currentColor`, no fills except the dots of "more". Names: summary, activity, accounts, investments, swap, tax, admin, plus, search, filter, chevron, close, info, mic, sun, moon, check, telegram, mail, lock. No emoji, and no text glyphs as icons.
- **Logo and app icon** (2026-10-04, `brand/BRAND.md` has the rules): the hourglass coin, a coin with its sides cut away so that an hourglass is left. The app icon is a flat `--accent` tile (`#2463EB`) with the mark in white. The dark twin is a `#1C1C1E` tile with the mark in the dark `--accent` (`#0A84FF`). The favicon and apple-touch-icon follow the theme (`-dark` files), the manifest icons stay light (no browser reads a dark manifest icon). The icon uses the small-size cut, because `icon-180` is also the favicon. The `icon()` SVG in `icons.js` is the only source for the PNGs. It stays square (the platform rounds it). No gradient and no ₱: the mark carries the idea.

## Charts
- A few charts, and each one answers one question. Draw them in SVG with the tokens above.
- **Shared month axis**: charts stacked in one tile use the same x scale, so each month is one column through all of them. One month label row sits under the last chart. The current month is labelled "so far" and its bars are drawn at 50% opacity.
- **Inspect**: hover (pointer) or tap (touch) a month to draw one vertical line through every chart in the tile. A tooltip then lists every value for that month.
- **Part-to-whole** is one stacked bar (Apple HIG: bar marks for proportions), not a pie: a 2px gap separates adjacent slices, and a slice takes its segment colour (`--ess`, `--rew`; the folded "Other" is `--dim`). The rows under it are the legend: dot, name, share, amount. "Other" is a button that opens its categories in place.
- Sparklines have no axes. Meters are 6–8px bars on `--track`. A target is a 2px tick on the meter.

## Motion
| What | How |
| --- | --- |
| Sheet or popover opens | Slides up or fades with scale 0.98→1, spring feel, `cubic-bezier(.2,.8,.2,1)` 320ms |
| Figure changes after a save | Rolls to the new value, 400ms |
| New row after a save | Slides in and fades from the top of the list, 250ms |
| Press on a tile or button | Scale 0.97 while pressed |
| Theme switch | Colours cross-fade 200ms |
Reduce Motion replaces all of it with a 150ms fade (the existing `prefers-reduced-motion` rule). Motion never delays input.

## Input parity and keys
- Touch targets are at least 44×44px. Nothing works only on hover. Every hover affordance has a tap or focus path.
- Swipe actions on iPhone rows (Delete, Select) also exist in the row's edit view and the Select button.
- Shortcuts (shown as ⌘ on Apple devices, Ctrl on others): **⌘K / Ctrl K** focuses the add field, **Esc** closes the top layer, **↑ ↓** move through a list, **Enter** opens the row, **⌘⇧L / Ctrl Shift L** switches light and dark.
- Theme has three states: Auto (follows the system), Light, Dark. The button cycles Light and Dark. A long press or right-click on it offers Auto. The choice is stored per device in `localStorage`, and `<meta name="theme-color">` follows it.

## Checklist for a new feature
1. Does the screen still lead with one answer? Put the new thing below it, or on its own screen.
2. Use existing tokens and components. A new colour or component goes into this file in the same commit.
3. Check it at 390, 820 and 1440 px wide, in light and dark, with the mouse and with touch emulation.
4. Every calculated figure has an ⓘ tooltip with its real formula (read the handler, do not guess).
5. Controls are 44px, inputs are 16px or larger, and nothing needs hover.
