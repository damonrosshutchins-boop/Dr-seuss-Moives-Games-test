# Runs the arcade server (frontend, approved game routes and the Wisp relay).
# Container hosts need outbound TCP, which Cloudflare Workers do not allow.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 7860
CMD ["npm", "start"]
