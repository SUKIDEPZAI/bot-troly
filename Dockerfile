FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# Có package-lock.json → cài đúng phiên bản đã khóa (npm ci); chưa có thì npm install.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi && npm cache clean --force
COPY src ./src
USER node
EXPOSE 10000
CMD ["node", "src/index.js"]
