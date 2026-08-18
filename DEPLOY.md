# Deploying Grand Line TCG

The app is a single zero-dependency Node process (`server/index.js`) that serves the website, the API, and the WebSocket game connections all from one port. That makes it deployable pretty much anywhere that can run a long-lived Node process. Pick whichever of these fits how you want to use it — all three are copy-paste.

Two things every option needs:
- **Node.js 22.5+** on the host (for `node:sqlite`).
- A place for the SQLite file to live if you want accounts/decks to survive restarts. The app already reads this from an env var — set **`DATA_DIR`** to a persistent folder/volume path (defaults to `~/.grand-line-tcg` in the server's home folder if you don't set it, which is fine locally but *not* fine on hosts with an ephemeral filesystem).

---

> **Shortcut:** `SHARE.md` has the click-by-click version of all of this, and the repo includes a `render.yaml` Blueprint (Render: New → Blueprint → pick repo → Apply) plus a `Dockerfile`/`railway.json` so no settings need typing.

## Option A — Render, free tier (fastest, $0, good for a weekend with friends)

Render's free web services support WebSockets fine, so the actual game works perfectly here. The catch: the free tier has **no persistent disk**, so the SQLite file (accounts, saved decks, and any open rooms) resets whenever the service redeploys or spins down from 15 minutes of inactivity. If you and your friends just want to jump in and play, this is the zero-effort option — you'll just need to re-register/rebuild a deck if it's been idle a while.

1. Push this project to a new GitHub repo (from inside the project folder):
   ```bash
   git init
   git add .
   git commit -m "Grand Line TCG"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/grand-line-tcg.git
   git push -u origin main
   ```
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service** → connect the repo you just pushed.
3. Fill in:
   - **Language:** `Node`
   - **Build Command:** *(leave blank — there's nothing to build)*
   - **Start Command:** `node server/index.js`
   - **Instance Type:** `Free`
4. Click **Create Web Service**. Render gives you a live `https://your-app.onrender.com` URL — and it's already `wss://`-capable, so no extra config is needed for the game to work.

Want the free tier's data to actually persist? Upgrade the same service to **Starter** ($7/mo), then open its **Disks** tab, mount a disk (e.g. `/data`, 1 GB is plenty — persistent disks are $0.25/GB/mo) and add an environment variable `DATA_DIR=/data`. Redeploy and your SQLite file now survives restarts.

---

## Option B — Railway (recommended if you want accounts/decks to actually stick around, ~$5/mo)

Railway is a normal always-on container host with real persistent volumes, deployed straight from your terminal — no GitHub required.

```bash
# 1. Install the CLI
curl -fsSL railway.com/install.sh | sh

# 2. Log in (opens a browser)
railway login

# 3. From inside the project folder, create a project and deploy it
railway init
railway up
```

Then, in the Railway dashboard for the project that just got created:
1. Open your new service → **Variables** tab → confirm/leave `PORT` as-is (Railway sets this automatically and the app already reads `process.env.PORT`).
2. Add a **Volume**: service → **Volumes** → **New Volume** → mount path `/data`.
3. Add a variable `DATA_DIR=/data`.
4. Service → **Settings** → **Networking** → **Generate Domain** to get a public `https://your-app.up.railway.app` URL (WebSockets work automatically over it).

Redeploy (`railway up` again, or it redeploys automatically after the settings change) and you're live with a database that survives restarts.

---

## Option C — Your own VPS (cheapest long-term, full control)

Any small VPS (DigitalOcean, Linode, Hetzner, a spare home server, etc.) works. This example uses Ubuntu/Debian, `systemd` to keep the app running and auto-restart it, and [Caddy](https://caddyserver.com) as a reverse proxy that gets you free automatic HTTPS (and therefore `wss://`) with zero manual certificate setup.

```bash
# --- on the server ---

# 1. Install Node 22+ (via nvm, so you don't need root-owned global installs)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
node --version   # confirm 22.5+

# 2. Get the code onto the server (pick one)
git clone https://github.com/YOUR_USERNAME/grand-line-tcg.git
# — or from your own machine: scp -r ./optcg-online you@your-server:/home/you/grand-line-tcg

cd grand-line-tcg
mkdir -p /home/you/optcg-data   # persistent folder for the SQLite file

# 3. Create a systemd service so it survives reboots/crashes
sudo tee /etc/systemd/system/optcg.service > /dev/null <<'EOF'
[Unit]
Description=Grand Line TCG
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/you/grand-line-tcg
Environment=PORT=3000
Environment=DATA_DIR=/home/you/optcg-data
ExecStart=/home/you/.nvm/versions/node/v22.22.2/bin/node server/index.js
Restart=always
User=you

[Install]
WantedBy=multi-user.target
EOF
# (fix the ExecStart node path to match `which node` for your install, and the
#  WorkingDirectory/User to match where you cloned it and your login user)

sudo systemctl daemon-reload
sudo systemctl enable --now optcg.service
sudo systemctl status optcg.service   # should show "active (running)"

# 4. Install Caddy and point it at your domain — this gets you free auto-HTTPS/WSS
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
your-domain.com {
    reverse_proxy localhost:3000
}
EOF
sudo systemctl restart caddy
```

Point your domain's DNS `A` record at the server's IP, wait for it to propagate, and `https://your-domain.com` is live — Caddy handles the TLS certificate automatically and proxies both regular requests and WebSocket upgrades to the app.

---

## After it's deployed

Send the URL to your friends, have everyone make an account (or just hit "Play as guest"), build/save a deck each in the **Deck Builder**, then one person creates a room from **Play Online** and shares the 5-letter code for the other to join. That's the whole flow.
