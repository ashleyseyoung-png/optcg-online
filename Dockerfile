# Runs anywhere Docker runs (Railway, Fly.io, Koyeb, a VPS, your NAS...).
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
