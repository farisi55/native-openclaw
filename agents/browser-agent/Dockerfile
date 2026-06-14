FROM node:20-alpine

WORKDIR /agent
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
    BROWSER_AGENT_PORT=3101 \
    BROWSER_AGENT_WORKSPACE=/workspace

RUN mkdir -p /workspace/artifacts/browser-agent && chown -R node:node /workspace /agent

USER node
EXPOSE 3101
CMD ["npm", "start"]
