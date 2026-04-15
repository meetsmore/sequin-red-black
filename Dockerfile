FROM debian:bookworm-slim

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      curl ca-certificates unzip && \
    rm -rf /var/lib/apt/lists/*

# Install Sequin CLI
RUN curl -sf https://raw.githubusercontent.com/sequinstream/sequin/main/cli/installer.sh | sh

# Install SRB binary (copied in at build time)
ARG SRB_BINARY=srb
COPY ${SRB_BINARY} /usr/local/bin/srb
RUN chmod +x /usr/local/bin/srb

ENV PATH="/root/.local/bin:${PATH}"

ENTRYPOINT ["srb"]
