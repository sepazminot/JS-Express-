# Usamos una versión ligera de Node.js
FROM node:22.11.0-alpine

# Crear directorio de trabajo
WORKDIR /usr/src/app

# Copiar archivos de dependencias primero para aprovechar el cache de Docker
COPY package*.json ./

ENV NODE_ENV=production

# Instalar dependencias de producción únicamente
RUN npm install --omit=dev

# Copiar el resto del código fuente
COPY . .

# Exponer el puerto
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["node", "server.js"]