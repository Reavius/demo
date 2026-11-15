FROM node:22-bookworm-slim
WORKDIR /app

# Upload this exact ZIP to the repository root on branch render-v6-archive.
COPY mechty-venue-site-v6-telegram.zip /tmp/mechty-v6.zip

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && unzip -q /tmp/mechty-v6.zip -d /app \
 && rm -f /tmp/mechty-v6.zip \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && npm test

ENV NODE_ENV=production
ENV HOST=0.0.0.0
# Free plan uses ephemeral storage only. Test data may be lost after restart/deploy.
ENV DATA_DIR=/tmp/mechty-test-data
ENV UPLOAD_DIR=/tmp/mechty-test-data/uploads

CMD ["node", "server.mjs"]
