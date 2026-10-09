FROM node:20.18.1-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
