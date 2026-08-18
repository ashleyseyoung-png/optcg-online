# How to play with your friends

Three ways, from "right now" to "permanent". All of them give you a link; your friends open it in a browser, hit **Play → Play as Guest** (or make an account), pick a starter deck, and join your room code. Nothing to install on their end.

---

## Option 1 — Right now, from your own computer (2 minutes, free, no accounts)

Best for: "let's test it tonight."

1. Open a terminal *inside the game folder* (in File Explorer: right-click empty space → **Open in Terminal**, or click the address bar, type `powershell`, Enter).
2. Run:
   ```
   npm run share
   ```
3. Wait ~10–30 seconds. It starts the game and prints a box like:
   ```
   ═══════════════════════════════════════════════
     🏴‍☠️  Share this link with your friends:

        https://something-random.trycloudflare.com

     Keep this window open while you play. Ctrl+C to stop.
   ═══════════════════════════════════════════════
   ```
4. Send that link to your friends. That's it — the game is running on your PC and the link tunnels straight to it (works for real-time play; the very first time it downloads a small helper).

Good to know: the link only works while that window is open, and it's a fresh random link each time. Your accounts/decks are still saved on your PC (`~/.grand-line-tcg`), so they carry over between sessions.

If it says it couldn't open a tunnel: install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) once (Windows: `winget install Cloudflare.cloudflared`), then run `npm run share` again.

---

## Option 2 — A permanent free link on the internet (10 minutes, free)

Best for: "I want a URL that's always up so people can play whenever."

This uses **Render's free tier** and needs a **GitHub** account (free). Everything Render needs is already configured in the `render.yaml` file, so it's basically clicking through.

**A. Put the code on GitHub (no git commands needed):**
1. Make a free account at [github.com](https://github.com) if you don't have one.
2. Download **GitHub Desktop** ([desktop.github.com](https://desktop.github.com)), sign in.
3. **File → Add Local Repository →** choose your game folder → it says it isn't a repository yet → click **create a repository** → **Create Repository**.
4. Type anything in the "Summary" box (e.g. `first upload`) → **Commit to main** → **Publish repository** (top button) → **Publish**.

**B. Deploy on Render:**
1. Go to [dashboard.render.com](https://dashboard.render.com) → sign up with **GitHub**.
2. Click **New +** → **Blueprint**.
3. Pick the repository you just published → **Connect** → **Apply**.
4. Wait a minute or two. Render gives you a URL like `https://grand-line-tcg-xxxx.onrender.com`. Send that to your friends.

Later updates: whenever you unzip a new version of the app over the folder, open GitHub Desktop → Commit → **Push**. Render redeploys automatically. (Each deploy also refreshes the card list from the public card database, so brand-new sets and alt arts appear without you doing anything.)

**Friend can't see card pictures?** Card art is loaded from two public card databases, and some networks/ISPs/browser extensions block those hosts. The app now falls back to fetching the art through your own site (`/api/card-image/...`), so everyone sees the same pictures — the first load of each card is a little slower for them, then it's cached on the server.

The one catch of the free tier: it "sleeps" after 15 minutes with nobody on it (first visitor waits ~30–60 s for it to wake up), and because the free tier has no persistent disk, accounts/decks made on the site are wiped when it redeploys or restarts. Fine for testing with friends — everyone can just use starter decks / guest mode. If that gets annoying, upgrading that same Render service to **Starter ($7/mo)** and adding a Disk (mount `/data`, then set the `DATA_DIR=/data` variable — it's already there commented-out in `render.yaml`) makes everything persist.

### If the Render deploy fails

Open the service in Render → **Logs** tab, and look at the last few red lines.

| What the log says | What it means | Fix |
|---|---|---|
| `No such built-in module: node:sqlite` or `Cannot find module 'node:sqlite'` | Render is running a Node older than 22.13 | The included `render.yaml` / `.node-version` now pin Node 22. Make sure both files are in your repo, then **Manual Deploy → Clear build cache & deploy**. |
| `Exited with status 1` right after "Loaded 2512 cards" | Something crashed at startup | Copy the lines above it — that's the real error. |
| Build fails on `npm install` | Nothing to install (this app has no dependencies), so this usually means the repo is missing `package.json` at its top level | Check that GitHub shows `package.json`, `server/`, `public/` at the *root* of the repo, not nested inside another folder. |
| Deploy "live" but the page won't load | Free instance waking up | Wait 30–60 seconds and refresh. |

---

## Option 3 — Permanent + remembers everyone's decks (~$5/mo)

**Railway**, deployed straight from your terminal, no GitHub needed. The `railway.json` and `Dockerfile` in this folder are already set up for it.

```
npm i -g @railway/cli      (once)
railway login              (opens a browser)
railway init               (from inside the game folder — pick "empty project")
railway up
```

Then in the Railway dashboard for that project: your service → **Volumes → New Volume**, mount path `/data` (the app already stores its database there when run from the Dockerfile) → **Settings → Networking → Generate Domain**. That URL is yours, always on, and keeps everyone's accounts and decks.

---

## Which one?

- Tonight with friends → **Option 1**.
- "Here's our group's site" → **Option 2** (free), or **Option 3** if you want saved accounts to stick around.
