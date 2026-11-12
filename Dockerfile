FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
COPY package.json ./
COPY src ./src
COPY web ./web
COPY config/cameras.json ./config/cameras.json
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "src/server.mjs"]
