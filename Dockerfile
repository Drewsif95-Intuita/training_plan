FROM node:24.19.0-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY public ./public
RUN node --test tests/*.test.mjs
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "src/server.mjs"]
