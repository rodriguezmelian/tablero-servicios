# Usar una imagen oficial y ligera de Node.js
FROM node:18-alpine

# Crear directorio de trabajo
WORKDIR /app

# Copiar dependencias y código fuente
COPY package*.json ./
RUN npm install --production

COPY . .

# Exponer el puerto del servidor
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["node", "server.js"]
