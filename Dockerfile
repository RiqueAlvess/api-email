FROM node:18-slim

RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates libnss3 libatk-bridge2.0-0 \
    libdrm2 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libxss1 libasound2 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
RUN npx playwright install firefox
RUN npx playwright install-deps firefox
COPY . .
EXPOSE 3000
CMD ["npm", "start"]