# Deploying the Slack relay to Azure

The relay is a single Node process with no dependencies and one piece of state
(`pairings.json`). It needs three things from its host: outbound network access,
one persistent directory, and **exactly one instance**.

## The one-instance rule

Do not scale the relay past one replica, and do not enable autoscale.

Two instances break it in two independent ways. Each opens its own Socket Mode
connection, so Slack load-balances events between them; and the queue of
pending events for each runner lives in memory, so a question can arrive at
instance A while that person's runner is long-polling instance B — the question
is then answered by nobody. Making the relay horizontally scalable would mean
moving both the Slack connection and the queues into shared infrastructure,
which is a different design and not worth it: the relay's whole job is shuffling
small JSON messages, and one small instance handles a whole company.

## Persistence

`$NEMEDA_RELAY_HOME/pairings.json` maps Slack user ids to runner token hashes.
Lose it and every teammate has to run `nemeda-agent slack join` again. On App
Service, `/home` is backed by Azure Files and survives redeploys as long as
`WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` is set — hence
`NEMEDA_RELAY_HOME=/home/nemeda-relay`.

The file contains no usable credential (hashes only) and no message content,
but it does map people to machines: it is written `0600`.

## Deploy

No local Docker needed — `az acr build` builds in the cloud. Run from the
repository root.

```bash
RG=nemeda-relay
LOC=westeurope
ACR=nemedarelay          # must be globally unique, lowercase alphanumeric
APP=nemeda-slack-relay   # must be globally unique

az group create -n $RG -l $LOC

az acr create -n $ACR -g $RG --sku Basic --admin-enabled true
az acr build -r $ACR -t relay:latest -f deploy/relay/Dockerfile .

az appservice plan create -n $APP-plan -g $RG --is-linux --sku B1
az webapp create -g $RG -p $APP-plan -n $APP \
  --deployment-container-image-name $ACR.azurecr.io/relay:latest
```

B1 is the cheapest tier that supports Always On, which the relay needs: without
it App Service idles the container out and the Slack connection dies.

```bash
az webapp config appsettings set -g $RG -n $APP --settings \
  SLACK_APP_TOKEN='xapp-...' \
  SLACK_BOT_TOKEN='xoxb-...' \
  NEMEDA_RELAY_HOME=/home/nemeda-relay \
  WEBSITES_ENABLE_APP_SERVICE_STORAGE=true \
  WEBSITES_PORT=8787

az webapp config set -g $RG -n $APP --always-on true
az webapp scale -g $RG -n $APP --instance-count 1
```

Tokens go in app settings, never in the image. Rotating them is an app-settings
edit plus a restart; runner tokens are unaffected.

Verify:

```bash
curl https://$APP.azurewebsites.net/healthz     # {"ok":true,...}
az webapp log tail -g $RG -n $APP               # "relay listening", "slack socket connected"
```

## Custom domain

```bash
az webapp config hostname add -g $RG -n $APP --hostname slack.example.com
az webapp config ssl create -g $RG -n $APP --hostname slack.example.com
az webapp config ssl bind -g $RG -n $APP --hostname slack.example.com --ssl-type SNI
```

Point a CNAME at `$APP.azurewebsites.net` first, plus the `asuid.` TXT record
App Service asks for.

## Moving people over

The relay URL is the only thing that changes. Each person edits
`NEMEDA_RELAY_URL` in `~/.nemeda/.env.local` and restarts their runner —
**no re-pairing**, because tokens live in the relay's state, not in the URL.
Re-pairing is only needed if `pairings.json` is lost.

## Notes for other hosts

- **Container Apps**: set `minReplicas: 1` *and* `maxReplicas: 1`, and mount an
  Azure Files volume at `NEMEDA_RELAY_HOME`. Scale-to-zero must stay off.
- **Fly / Railway / a VPS**: same three requirements. On a VPS, systemd plus a
  directory under `/var/lib` is enough, with Caddy in front for TLS.
- The image runs as root because App Service mounts `/home` as root. On a host
  where you control the volume, add a non-root `USER` and chown the directory.
