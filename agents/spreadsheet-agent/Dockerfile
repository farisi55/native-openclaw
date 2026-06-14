FROM node:20-alpine

WORKDIR /agent
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
    SPREADSHEET_AGENT_PORT=3103 \
    SPREADSHEET_AGENT_WORKSPACE=/workspace

RUN mkdir -p /workspace/artifacts/spreadsheet-agent && chown -R node:node /workspace /agent

USER node
EXPOSE 3103
CMD ["npm", "start"]
