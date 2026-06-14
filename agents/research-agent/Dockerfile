FROM node:20-alpine

WORKDIR /agent
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
    RESEARCH_AGENT_PORT=3102 \
    RESEARCH_AGENT_WORKSPACE=/workspace

RUN mkdir -p /workspace/artifacts/research-agent && chown -R node:node /workspace /agent

USER node
EXPOSE 3102
CMD ["npm", "start"]
