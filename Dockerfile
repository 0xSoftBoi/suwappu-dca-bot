FROM oven/bun:1.3.14
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY examples ./examples

RUN mkdir -p /data && chown bun:bun /data
ENV SUWAPPU_DCA_STATE_DIR=/data
USER bun
VOLUME ["/data"]

# A default container start validates the example plan and exits without a
# network request. Scheduling and managed execution are explicit commands.
CMD ["bun", "src/index.ts", "status", "--config", "examples/dca-config.example.json"]
