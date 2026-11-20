# Build the UI, then serve it with the proxy.
FROM node:24-alpine AS build
WORKDIR /app
COPY ui ./ui
RUN cd ui/apps/chat && npm ci && npm run build

FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
COPY --from=build /app/ui/apps/chat/dist ./ui/apps/chat/dist
ENV PORT=8080 UPSTREAM=http://127.0.0.1:8888 MODEL_ID=local-model N_CTX=65556
EXPOSE 8080
CMD ["node", "server.mjs"]
