FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

ENV PORT=3000
CMD ["node", "node-server.js"]
