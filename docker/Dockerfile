FROM node:20-slim
WORKDIR /app
COPY packages/server/dist ./dist
COPY packages/server/package.json ./
RUN npm install --production
EXPOSE 4400
ENTRYPOINT ["node", "dist/cli.js"]
