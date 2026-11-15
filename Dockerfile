FROM node:22-bookworm-slim
WORKDIR /app
COPY mechty-venue-site-v6-telegram.zip /tmp/mechty-v6.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && unzip -q /tmp/mechty-v6.zip -d /app \
 && rm -rf /var/lib/apt/lists/* /tmp/mechty-v6.zip
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DATA_DIR=/tmp/mechty-data
ENV UPLOAD_DIR=/tmp/mechty-data/uploads
EXPOSE 10000
CMD ["node", "server.mjs"]
