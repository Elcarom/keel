# Running Keel on Unraid

Keel runs as a single non-root container (`PUID=99`, `PGID=100`, `UMASK=022`) exposing port `8080` for both the Fastify API and the React dashboard, designed to sit behind your **Cloudflare Tunnel (`cloudflared`)**.

---

## 1. Host Directories on Unraid

Create the persistent application data and backup folders on your Unraid cache/array:

```bash
mkdir -p /mnt/user/appdata/keel/data /mnt/user/appdata/keel/backups
chown -R 99:100 /mnt/user/appdata/keel
```

- `/mnt/user/appdata/keel/data` (`-> /data`): Holds the SQLite WAL database (`keel.db`), the `AES-256-GCM` master key (`secret.key`, mode `0600`), and historical market data snapshots.
- `/mnt/user/appdata/keel/backups` (`-> /backups`): Holds point-in-time atomic SQLite backups created via `VACUUM INTO`.

---

## 2. Installation Options

### Option A: Unraid Compose Manager (`docker-compose.yml`)

1. Install the **Docker Compose Manager** plugin from Unraid Community Applications.
2. Add a new stack named `keel` and paste the contents of [`docker-compose.yml`](../docker-compose.yml).
3. Click **Compose Up**.

### Option B: Unraid Community Apps XML Template

1. Copy [`deploy/unraid/keel-template.xml`](../deploy/unraid/keel-template.xml) to `/boot/config/plugins/dockerMan/templates-user/my-keel.xml` on your Unraid flash drive.
2. In the Unraid WebGUI, go to **Docker → Add Container** and select **Keel** from the **Template** dropdown.
3. Verify the `/data`, `/backups`, and port `8080` mappings, then click **Apply**.

### Moving from the old image name

The repository was renamed from `psychic-octo-funicular` to `keel`, so the image is now `ghcr.io/elcarom/keel:latest`. For now the old name is still published, so an existing install keeps updating. To switch:

1. In **Docker**, click the Keel icon and choose **Edit**.
2. Change **Repository** to `ghcr.io/elcarom/keel:latest`.
3. Click **Apply**.

Your data and backups stay where they are, because only the image name changes.

---

## 3. Cloudflare Tunnel (`cloudflared`) Setup

1. In your **Cloudflare Zero Trust Dashboard**, go to **Networks → Tunnels** and select your Unraid tunnel.
2. Add a **Public Hostname** (e.g. `keel.yourdomain.com`) pointing to:
   - **Type**: `HTTP`
   - **URL**: `<unraid-lan-ip>:8080` (or `keel:8080` if sharing a custom Docker network with `cloudflared`).
3. _(Recommended)_ Attach a **Cloudflare Access Application** policy requiring your identity provider + OTP at the edge. Keel also enforces its own mandatory local admin session (`Argon2id`) and TOTP step-up confirmation inside the app ([ADR-0003](./adr/0003-cloudflare-tunnel-and-defense-in-depth-auth.md)).
4. Keel automatically emits a **15-second SSE heartbeat** on `/api/v1/stream/heartbeat` so Cloudflare's 100-second edge read timeout never drops live dashboard streams.

---

## 4. First-Boot Admin Bootstrap

Keel never exposes an open setup page. On first boot against an empty `/data` volume:

1. Open the container logs in Unraid (`docker logs keel`).
2. Copy the one-time bootstrap setup token printed to stdout.
3. Visit your Keel URL, enter the bootstrap token, set your strong admin password, and enroll your TOTP authenticator.

---

## 5. Updating & Graceful Shutdown

- When Unraid stops or updates the container, `tini` forwards `SIGTERM` to Keel (`--stop-timeout=30`).
- By default (`system.shutdownPolicy = "hold"`), Keel stops background scheduler ingestion loops cleanly and flushes the SQLite WAL, leaving any open Demo/Live positions protected by their exchange-resident mark-price **Protective Stops** (`attachAlgoOrds`), and OKX's 60-second **Dead-Man's Switch** (`cancel-all-after`) automatically cancels any unexecuted resting limit orders ([ADR-0006](./adr/0006-okx-attached-protective-stops-and-dead-mans-switch.md)).
