FROM node:24-slim AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:24-slim AS build

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/opencode.json ./opencode.json

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
