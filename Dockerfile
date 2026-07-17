FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node src ./src

USER node
EXPOSE 3001
CMD ["node", "src/server.js"]
