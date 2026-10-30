# Minimal image — the server uses only Node.js built-ins, so there is no
# dependency install step and nothing but server.js to copy in.
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./

# Where captures.txt is written. Mount a Coolify volume here so the log
# survives redeploys (see README.md -> Persistent storage).
ENV DATA_DIR=/data
ENV PORT=3000
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]
