FROM node:16
WORKDIR /usr/src/app
RUN mkdir /usr/src/app/.caches
COPY package*.json ./
RUN npm install
COPY src/ ./
ARG AUTH_KEY
ENV AUTH_KEY=${AUTH_KEY}
EXPOSE 8080
CMD [ "node", "index.js" ]