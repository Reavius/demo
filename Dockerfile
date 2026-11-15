FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0
ENV DATA_DIR=/tmp/mechty-data
ENV UPLOAD_DIR=/tmp/mechty-data/uploads
EXPOSE 10000
CMD ["node", "server.mjs"]
