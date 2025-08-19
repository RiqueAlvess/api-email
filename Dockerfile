FROM node:18-slim

# Instalar dependências do sistema para Firefox
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json e instalar dependências Node
COPY package*.json ./
RUN npm install --only=production

# Instalar Firefox para Playwright
RUN npx playwright install firefox
RUN npx playwright install-deps firefox

# Copiar código da aplicação
COPY . .

# Expor porta
EXPOSE 3000

# Iniciar aplicação
CMD ["npm", "start"]
