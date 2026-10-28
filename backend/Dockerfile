# WalkIn backend: API + in-process reconstruction worker.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY fixtures ./fixtures
COPY tsconfig.json ./
# Persist job table, scenes and masks by mounting a volume here.
ENV DATA_DIR=/data
EXPOSE 8787
CMD ["npm", "start"]
