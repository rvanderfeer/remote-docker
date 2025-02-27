FROM golang:1.21-alpine AS builder
ENV CGO_ENABLED=0
WORKDIR /backend
COPY backend/go.* .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download
COPY backend/. .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags="-s -w" -o bin/service

FROM --platform=$BUILDPLATFORM node:21.6-alpine3.18 AS client-builder
WORKDIR /ui
# cache packages in layer
COPY ui/package.json /ui/package.json
COPY ui/package-lock.json /ui/package-lock.json
RUN --mount=type=cache,target=/usr/src/app/.npm \
    npm set cache /usr/src/app/.npm && \
    npm ci
# install
COPY ui /ui
RUN npm run build

FROM alpine
LABEL org.opencontainers.image.title="Remote Docker" \
    org.opencontainers.image.description="A Docker Desktop extension for managing and monitoring remote Docker environments via SSH tunneling." \
    org.opencontainers.image.vendor="Ege Kocabaş" \
    com.docker.desktop.extension.api.version="0.3.4" \
    com.docker.extension.screenshots="" \
    com.docker.desktop.extension.icon="extension-icon.svg" \
    com.docker.extension.detailed-description="\
    A Docker Desktop extension that brings remote Docker management with a user-friendly UI.<br><br>\
    <b>Key Features:</b><br><br>\
    - Full remote Docker environment management via SSH tunneling<br>\
    - Real-time container logs for quick troubleshooting<br>\
    - Compact CLI-style log view<br>\
    - Isolated tabbed views per container<br>\
    - Persistent environment settings for easy access<br>\
    - Dashboard with live container, image, volume, and network insights<br><br>\
    <b>Architecture:</b><br><br>\
    - <b>Backend (Go)</b>: Handles SSH tunnel creation and proxies Docker commands to remote hosts<br>\
    - <b>Frontend (React/TypeScript)</b>: Provides a responsive UI for managing remote Docker instances<br><br>\
    <b>Security Considerations:</b><br>\
    - Mounts local SSH keys as read-only from <code>~/.ssh</code> into the extension container<br>\
    - Uses an isolated OpenSSH client inside the extension<br>\
    - Executes all commands securely over an SSH tunnel<br>\
    - No external API calls are made<br><br>\
    <b>Usage:</b><br>\
    - Install the extension from Docker Hub<br>\
    - Configure remote environments via the settings panel<br>\
    - Select a remote instance and start managing Docker remotely<br><br>\
    <b>Warning:</b> Use this extension at your own risk. Always review the code and validate actions before running or installing it.<br><br>\
    " \
    com.docker.extension.publisher-url="https://github.com/egekocabas/remote-docker" \
    com.docker.extension.additional-urls="[{\"title\":\"Project GitHub\",\"url\":\"https:\/\/github.com\/egekocabas\/remote-docker\"}]" \
    com.docker.extension.changelog="Initial release" \
    com.docker.extension.categories="container-orchestration,utility-tools" \

# Install SSH client
RUN apk add --no-cache openssh-client docker

# Install ca-certificates for Docker client
RUN apk add --no-cache ca-certificates

# Create necessary SSH directories
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

COPY --from=builder /backend/bin/service /
COPY docker-compose.yaml .
COPY metadata.json .
COPY assets/extension-icon.svg .
COPY --from=client-builder /ui/build ui
CMD /service -socket /run/guest-services/backend.sock
