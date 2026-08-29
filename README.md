# History Keeper

**Chrome throws away your browsing history after 90 days. This keeps it.**

Chrome's history is a rolling 90-day window, and Chrome Sync copies that same expiry to
every device you own — so the page you half-remember reading two years ago is just
gone, and there is no setting to turn that off.

History Keeper is a Chrome extension that keeps its own copy. Every page you
visit is saved to a private archive on your machine that nothing expires, plus whatever
is still inside Chrome's 90-day window when you install it. Search it years later.

Everything stays on your computer. The extension has no server, no account, and no
network access at all.

## Features

- **Unlimited\* History** Visits are recorded as they happen and never expire. Clearing
  history in Chrome doesn't touch it.
- **Search that tolerates bad memory.** Type roughly what you remember — partial words,
  wrong order, typos — and results appear as you type. `gthb` finds github.com; `pythom`
  finds python.
- **One history across your machines.** Point each computer at the same Dropbox / Google
  Drive / OneDrive folder and your desktop and laptop archives merge into one. No account,
  no sync service — just files in a folder you already have.
- **Stats.** How many pages, how far back your archive reaches, which sites you actually
  spend your time on.
- **A blocklist.** Sites you'd rather not have on record are never written down, and can
  be purged retroactively if you add them later.

## Install

Chrome 116 or newer. It's not on the Chrome Web Store, so it loads unpacked — about a
minute:

1. Get the source, either with git:

   ```bash
   git clone https://github.com/jaasonw/history_keeper.git
   ```

   or by downloading
   [the ZIP](https://github.com/jaasonw/history_keeper/archive/refs/heads/main.zip) and
   unpacking it somewhere permanent — Chrome reloads the extension from this folder every
   time it starts, so moving or deleting it later breaks the extension.

2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `history_keeper` folder — the one with
   `manifest.json` in it.

That's it. There's nothing to build and nothing to install. The import of your existing
Chrome history starts immediately; progress shows in the popup.

To update later: `git pull`, then hit the reload icon on the extension's card. Your
archive survives the reload.

## Using it

The toolbar button opens the popup — a running count and a link into the dashboard. (Pin
it from the puzzle-piece menu if you want it always there.)

The **dashboard** is where you search. Results update as you type; **Best match** groups
by page, **Newest first** lists visits in order. The ✕ on any row removes it from the
archive. It also holds sync setup, stats, and backup.

The **options** page has the blocklist, the label for this device, a light/dark theme
toggle, and maintenance buttons if you ever want to force a re-scan of Chrome's history.

### Syncing across computers

On the dashboard, click **Connect folder** and choose a folder inside your cloud drive.
Do the same on your other machines, pointing at the same folder. Each device writes its
own files and reads everyone else's, so nothing ever conflicts — and importing the same
data twice changes nothing.

Sync runs while the dashboard tab is open, on load and every 5 minutes.

**One quirk:** Chrome doesn't reliably remember folder permission across browser
restarts. When it lapses, the dashboard shows a **Reconnect folder** button; one click
and it's back.

### Backups without a cloud folder

**Download snapshot** on the dashboard writes your whole archive to a single file, and
**Import file…** merges one back in — handy for moving to a new computer or just keeping
a copy. Importing the same snapshot twice is harmless.

### Blocklist

Options page, empty by default. One pattern per line:

```
mybank.example          that host and all subdomains
*.internal.corp         subdomains only
/\/health\/records\//i  regular expression against the whole URL
# comment
```

New visits matching a pattern are never recorded. **Purge matches already archived**
removes ones you'd already collected.

## Privacy

Nothing leaves your machine. The extension requests no host permissions and makes no
network requests — the only data that ever moves is the files you explicitly point the
sync folder at.

Worth knowing:

- **Incognito is never recorded.** Those visits don't reach Chrome's history at all.
- **Page contents aren't saved** — only the URL, title, time, and how you got there.
- **The archive isn't encrypted**, on disk or in the cloud folder. If someone can read
  your files, they can read your history.
- **Deleting history in Chrome doesn't delete it here.** That's the whole point, but it
  does mean "clear browsing data" no longer clears everything. Use the ✕ on a dashboard
  row, or a blocklist pattern plus purge.

## Contributing

```bash
npm install && npm test
```

Plain ES modules loaded straight by Chrome — no build step, no runtime dependencies,
no test framework. [`AGENTS.md`](AGENTS.md) is the short contract and
[`ARCHITECTURE.md`](ARCHITECTURE.md) the detail: execution
contexts, the invariants that keep merges conflict-free, and what a schema change
requires.
