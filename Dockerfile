FROM node:24-bookworm

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 10000
CMD ["node", "src/index.js"]
