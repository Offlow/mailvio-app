# Mailvio — container-image voor Fly.io (en lokaal met "docker build/run").
FROM node:20-slim

WORKDIR /app

# Eerst enkel de package-bestanden kopiëren zodat Docker de npm-install-laag
# kan hergebruiken zolang de dependencies niet veranderen (snellere rebuilds).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Dan de rest van de broncode.
COPY . .

# Map voor de opgeslagen instellingen (IMAP/SMTP/API-sleutel). Op Fly.io wordt
# hier een persistente Volume overheen gemount (zie fly.toml) zodat deze data
# een herdeploy overleeft — in tegenstelling tot het gratis Render-plan.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
