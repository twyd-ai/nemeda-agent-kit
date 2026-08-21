# The Slack relay. No dependencies to install: the kit is zero-dependency and
# the relay uses only Node's standard library, so the image is the runtime
# plus a handful of .mjs files.
FROM node:22-alpine

# NEMEDA_RELAY_HOME must point at persistent storage, or every redeploy
# forgets who is paired and everyone has to run `slack join` again.
ENV NODE_ENV=production \
    NEMEDA_RELAY_HOME=/home/nemeda-relay \
    PORT=8787

WORKDIR /app

COPY plugins/nemeda-agent-kit/package.json ./plugins/nemeda-agent-kit/
COPY plugins/nemeda-agent-kit/scripts/lib/env.mjs ./plugins/nemeda-agent-kit/scripts/lib/
COPY plugins/nemeda-agent-kit/scripts/lib/relay-protocol.mjs ./plugins/nemeda-agent-kit/scripts/lib/
COPY plugins/nemeda-agent-kit/scripts/slack/relay.mjs ./plugins/nemeda-agent-kit/scripts/slack/

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "plugins/nemeda-agent-kit/scripts/slack/relay.mjs"]
