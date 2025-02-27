<h1>
  <img src="/extension-icon.svg" alt="Project Logo" width="100" height="100" style="vertical-align: middle; margin-right: 10px;">
  Remote Docker
</h1>

A Docker Desktop extension that allows you to manage and monitor remote Docker environments through SSH tunneling.

### 🚀 Features

- Essentially **Docker Desktop inside Docker Desktop** - replicates most Docker Desktop UI functionality for remote hosts
- SSH tunnel management to remote hosts
- Dashboard with stats
- Containers, images, volumes and networks views
- Container log view
- Persistent environment settings

### 📋 Components

> This project was created with the `docker extension init` command, which sets up Go as the backend and ReactJS as the frontend. Most of the code was generated with Claude 3.7 Sonnet.

The extension consists of two main parts:

1. **Backend (Go)**
    - Handles SSH tunnel creation and management
    - Proxies Docker commands to remote hosts

2. **Frontend (React/TypeScript)**
    - Provides a UI for remote Docker management
    - Features a responsive dashboard with real-time updates
    - Built with Material UI components and recharts for data visualization

> **Note**: Modularization, separation of concerns, and other best practices were not prioritized as this was an experimental project to explore LLM capabilities and Docker Desktop extension development.

### 🔒 SSH Authentication & Considerations

- The extension mounts your local `~/.ssh` directory as read-only (`~/.ssh:/root/.ssh:ro`) into the extension container
- The extension's backend installs its own SSH client (via `openssh-client`)
- SSH connections are made from within the backend container using your mounted SSH keys
- The extension invokes the SSH command with username and hostname parameters
- Being open source allows inspection of the code to verify security practices
- All (Docker) commands are executed on the remote server via the SSH tunnel
- No external API calls are made

### 📖 Getting Started

1. Install the extension using the image on Docker Hub
2. Add your remote environments in the Settings tab
3. Select an environment to connect
4. Start managing your remote Docker environment

> **Warning:** Use this extension at your own risk. Always review and validate the actions performed on your remote Docker environments.
> Always review the code before running or installing this extension. Ensure you understand the permissions and security implications before granting access to remote hosts.

### 🤝 Contributing
No active development or feature roadmap is planned. This project was primarily an experimental exploration of Docker Desktop extension development and LLM-assisted coding.


### 🎨 Design

- The extension icon was created using Midjourney.
- Material UI (MUI) was used as the component library following Docker's official recommendation for extension development. Docker Desktop itself is built with React and MUI, making this the most compatible choice for extensions. For more information, see the [Docker Extensions design guidelines](https://docs.docker.com/extensions/extensions-sdk/design/#step-one-choose-your-framework).

### 📄 License
This project is licensed under the MIT License.