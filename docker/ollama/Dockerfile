FROM ollama/ollama:latest

ARG OLLAMA_PRELOAD_MODEL=qwen2.5:0.5b

RUN ollama serve & \
    sleep 5 && \
    ollama pull "${OLLAMA_PRELOAD_MODEL}" && \
    pkill ollama || true

EXPOSE 11434
