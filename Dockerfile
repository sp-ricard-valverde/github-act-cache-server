FROM node:16
WORKDIR /usr/src/app
RUN mkdir /usr/src/app/.caches
COPY package*.json ./
RUN npm install
COPY src src
ARG AUTH_KEY
ENV AUTH_KEY=${AUTH_KEY}
EXPOSE 8080
# development
#CMD [ "npx", "nodemon", "src/index.js" ]
# production
CMD [ "node", "src/index.js" ]