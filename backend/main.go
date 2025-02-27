package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/ioutil"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/sirupsen/logrus"
)

var (
	logger        = logrus.New()
	tunnelManager *SSHTunnelManager
)

// SSH tunnel manager that maintains persistent connections
type SSHTunnelManager struct {
	activeConnections map[string]*SSHConnection
	mutex             sync.Mutex
	controlDir        string
}

// SSH connection information
type SSHConnection struct {
	Username    string
	Hostname    string
	ControlPath string
	Cmd         *exec.Cmd
	LastUsed    time.Time
	Active      bool
}

type SSHConnectionRequest struct {
	Hostname string `json:"hostname"`
	Username string `json:"username"`
}

type DockerContainer struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Image          string `json:"image"`
	Status         string `json:"status"`
	Ports          string `json:"ports"`
	Labels         string `json:"labels"`         // New field to store raw label string
	ComposeProject string `json:"composeProject"` // Computed field if the container is part of a Compose project
}

// A group of containers under the same Compose project
type ComposeGroup struct {
	Name       string            `json:"name"`
	Status     string            `json:"status"` // e.g. "Running(3)", "Partial(2/3)", etc.
	Containers []DockerContainer `json:"containers"`
}

// Final response structure
type DockerContainerResponse struct {
	ComposeGroups []ComposeGroup    `json:"composeGroups"`
	Ungrouped     []DockerContainer `json:"ungrouped"`
}

// Settings data file path
const settingsFilePath = "/root/docker-extension/settings.json"

func main() {
	var socketPath string
	flag.StringVar(&socketPath, "socket", "/run/guest-services/backend.sock", "Unix domain socket to listen on")
	flag.Parse()

	_ = os.RemoveAll(socketPath)

	logger.SetOutput(os.Stdout)

	// Initialize SSH tunnel manager
	var err error
	tunnelManager, err = NewSSHTunnelManager()
	if err != nil {
		logger.Fatalf("Failed to initialize SSH tunnel manager: %v", err)
	}

	// Start cleanup routine for idle connections (check every minute, timeout after 30 minutes)
	tunnelManager.StartCleanupRoutine(1*time.Minute, 30*time.Minute)

	logMiddleware := middleware.LoggerWithConfig(middleware.LoggerConfig{
		Skipper: middleware.DefaultSkipper,
		Format: `{"time":"${time_rfc3339_nano}","id":"${id}",` +
			`"method":"${method}","uri":"${uri}",` +
			`"status":${status},"error":"${error}"` +
			`}` + "\n",
		CustomTimeFormat: "2006-01-02 15:04:05.00000",
		Output:           logger.Writer(),
	})

	logger.Infof("Starting listening on %s\n", socketPath)
	router := echo.New()
	router.HideBanner = true
	router.Use(logMiddleware)
	startURL := ""

	ln, err := listen(socketPath)
	if err != nil {
		logger.Fatal(err)
	}
	router.Listener = ln

	router.GET("/hello", hello)
	router.POST("/connect", connectToRemoteDocker)
	// Get settings
	router.GET("/settings", getSettings)
	// Save settings
	router.POST("/settings", saveSettings)

	router.POST("/tunnel/open", openTunnel)
	router.POST("/tunnel/close", closeTunnel)
	router.GET("/tunnel/status", getTunnelStatus)
	router.GET("/tunnel/list", listTunnels)

	// Container management endpoints
	router.POST("/container/start", startContainer)
	router.POST("/container/stop", stopContainer)

	// Image management endpoints
	router.POST("/images/list", listImages)

	// Volume management endpoints
	router.POST("/volumes/list", listVolumes)
	router.POST("/volumes/remove", removeVolume)

	// Network management endpoints
	router.POST("/networks/list", listNetworks)
	router.POST("/networks/remove", removeNetwork)

	router.POST("/container/logs", getContainerLogs)
	router.POST("/compose/logs", getComposeLogs)

	// Graceful shutdown handling
	c := make(chan os.Signal, 1)
	go func() {
		<-c
		logger.Info("Shutting down, closing all SSH connections...")
		tunnelManager.CloseAllConnections()
		os.Exit(0)
	}()

	logger.Fatal(router.Start(startURL))
}

// Request for container logs
type ContainerLogsRequest struct {
	Hostname    string `json:"hostname"`
	Username    string `json:"username"`
	ContainerId string `json:"containerId"`
	Tail        int    `json:"tail"`       // Number of lines to show from the end
	Timestamps  bool   `json:"timestamps"` // Show timestamps
}

// Stream container logs
// Stream container logs with keepalive
func getContainerLogs(ctx echo.Context) error {
	var req ContainerLogsRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" || req.ContainerId == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Build docker logs command with appropriate options
	dockerCmd := strings.Builder{}
	dockerCmd.WriteString("docker logs")

	// Add options
	if req.Tail > 0 {
		dockerCmd.WriteString(fmt.Sprintf(" --tail %d", req.Tail))
	}
	if req.Timestamps {
		dockerCmd.WriteString(" --timestamps")
	}

	// Add container ID
	dockerCmd.WriteString(fmt.Sprintf(" %s", req.ContainerId))

	logger.Infof("Executing log command: %s", dockerCmd.String())

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCmd.String())
	if err != nil {
		logger.Errorf("Error reading logs: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to read logs: %v", err),
			"output": string(output),
		})
	}

	// Split into lines for returning a JSON array
	lines := strings.Split(string(output), "\n")
	// If the last line is empty, trim it
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}

	return ctx.JSON(http.StatusOK, ContainerLogsResponse{Success: "true", Logs: lines})
}

type ComposeLogsRequest struct {
	Hostname       string `json:"hostname"`
	Username       string `json:"username"`
	ComposeProject string `json:"composeProject"`
	Tail           int    `json:"tail"`       // Number of lines to show from the end
	Timestamps     bool   `json:"timestamps"` // Show timestamps
}

func getComposeLogs(ctx echo.Context) error {
	var req ComposeLogsRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" || req.ComposeProject == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Build docker logs command with appropriate options
	dockerCmd := strings.Builder{}
	dockerCmd.WriteString(fmt.Sprintf("docker compose -p %s logs", req.ComposeProject))

	// Add options
	if req.Tail > 0 {
		dockerCmd.WriteString(fmt.Sprintf(" --tail %d", req.Tail))
	}
	if req.Timestamps {
		dockerCmd.WriteString(" --timestamps")
	}

	logger.Infof("Executing log command: %s", dockerCmd.String())

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCmd.String())
	if err != nil {
		logger.Errorf("Error reading logs: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to read logs: %v", err),
			"output": string(output),
		})
	}

	// Split into lines for returning a JSON array
	lines := strings.Split(string(output), "\n")
	// If the last line is empty, trim it
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}

	return ctx.JSON(http.StatusOK, ContainerLogsResponse{Success: "true", Logs: lines})
}

// ContainerLogsResponse is what we'll return in JSON.
type ContainerLogsResponse struct {
	Success string   `json:"success"`
	Logs    []string `json:"logs"`
}

// Create a new SSH tunnel manager
func NewSSHTunnelManager() (*SSHTunnelManager, error) {
	// Create directory for SSH control sockets
	controlDir := "/tmp/docker-remote-ssh"
	if err := os.MkdirAll(controlDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create control directory: %v", err)
	}

	return &SSHTunnelManager{
		activeConnections: make(map[string]*SSHConnection),
		controlDir:        controlDir,
	}, nil
}

// Generate connection key for mapping
func connectionKey(username, hostname string) string {
	return fmt.Sprintf("%s@%s", username, hostname)
}

// Create and start a new SSH connection
func (m *SSHTunnelManager) OpenConnection(username, hostname string) error {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	key := connectionKey(username, hostname)

	// Check if connection already exists
	if conn, exists := m.activeConnections[key]; exists && conn.Active {
		// Update last used time
		conn.LastUsed = time.Now()
		logger.Infof("Reusing existing SSH connection for %s", key)
		return nil
	}

	// Create control socket path
	controlPath := filepath.Join(m.controlDir, fmt.Sprintf("ssh-%s.sock", key))

	// Remove existing control socket if it exists
	if _, err := os.Stat(controlPath); err == nil {
		if err := os.Remove(controlPath); err != nil {
			logger.Warnf("Failed to remove existing control socket: %v", err)
		}
	}

	// Start SSH master connection with control socket
	cmd := exec.Command("ssh",
		"-M",              // Master mode for connection sharing
		"-S", controlPath, // Control socket path
		"-o", "ControlPersist=yes",
		"-o", "ServerAliveInterval=10",
		"-o", "ServerAliveCountMax=2",
		"-o", "StrictHostKeyChecking=no",
		"-o", "BatchMode=yes", // Non-interactive mode
		"-N", // Don't execute any command, just forward
		fmt.Sprintf("%s@%s", username, hostname),
	)

	// Start the SSH connection
	logger.Infof("Starting new SSH master connection for %s", key)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start SSH connection: %v", err)
	}

	// Wait a moment for connection to establish
	time.Sleep(1 * time.Second)

	// Check if connection was successful by running a test command
	testCmd := exec.Command("ssh",
		"-o ConnectTimeout=5",
		"-S", controlPath,
		"-o", "StrictHostKeyChecking=no",
		fmt.Sprintf("%s@%s", username, hostname),
		"echo 'Connection test'",
	)

	output, err := testCmd.CombinedOutput()
	if err != nil {
		// Try to kill the master connection if test failed
		cmd.Process.Kill()
		return fmt.Errorf("failed to establish SSH connection: %v, output: %s", err, string(output))
	}

	// Store the connection
	m.activeConnections[key] = &SSHConnection{
		Username:    username,
		Hostname:    hostname,
		ControlPath: controlPath,
		Cmd:         cmd,
		LastUsed:    time.Now(),
		Active:      true,
	}

	logger.Infof("Successfully established SSH connection for %s", key)
	return nil
}

// Close a specific SSH connection
func (m *SSHTunnelManager) CloseConnection(username, hostname string) error {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	key := connectionKey(username, hostname)
	conn, exists := m.activeConnections[key]
	if !exists || !conn.Active {
		return nil // Connection doesn't exist or is already closed
	}

	// Close the connection using control socket
	closeCmd := exec.Command("ssh",
		"-o ConnectTimeout=5",
		"-S", conn.ControlPath,
		"-O", "exit", // Send exit command to master process
		fmt.Sprintf("%s@%s", username, hostname),
	)

	logger.Infof("Closing SSH connection for %s", key)
	output, err := closeCmd.CombinedOutput()
	if err != nil {
		logger.Warnf("Error closing SSH connection cleanly: %v, output: %s", err, string(output))
		// Try to kill the process directly if clean exit fails
		if conn.Cmd != nil && conn.Cmd.Process != nil {
			conn.Cmd.Process.Kill()
		}
	}

	// Clean up the control socket
	if _, err := os.Stat(conn.ControlPath); err == nil {
		if err := os.Remove(conn.ControlPath); err != nil {
			logger.Warnf("Failed to remove control socket: %v", err)
		}
	}

	// Mark as inactive and remove from map
	conn.Active = false
	delete(m.activeConnections, key)

	return nil
}

// Close all active SSH connections
func (m *SSHTunnelManager) CloseAllConnections() {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	for key, conn := range m.activeConnections {
		if conn.Active {
			// Close the connection using control socket
			closeCmd := exec.Command("ssh",
				"-o ConnectTimeout=5",
				"-S", conn.ControlPath,
				"-O", "exit",
				fmt.Sprintf("%s@%s", conn.Username, conn.Hostname),
			)

			logger.Infof("Closing SSH connection for %s", key)
			output, err := closeCmd.CombinedOutput()
			if err != nil {
				logger.Warnf("Error closing SSH connection cleanly: %v, output: %s", err, string(output))
				// Try to kill the process directly
				if conn.Cmd != nil && conn.Cmd.Process != nil {
					conn.Cmd.Process.Kill()
				}
			}

			// Clean up control socket
			if _, err := os.Stat(conn.ControlPath); err == nil {
				os.Remove(conn.ControlPath)
			}
		}
	}

	// Clear the map
	m.activeConnections = make(map[string]*SSHConnection)
}

// Execute a command using an existing SSH connection
func (m *SSHTunnelManager) ExecuteCommand(username, hostname, command string) ([]byte, error) {
	m.mutex.Lock()
	key := connectionKey(username, hostname)
	conn, exists := m.activeConnections[key]

	if !exists || !conn.Active {
		// No active connection, try to open one
		m.mutex.Unlock()
		if err := m.OpenConnection(username, hostname); err != nil {
			return nil, fmt.Errorf("failed to open connection: %v", err)
		}
		m.mutex.Lock()
		conn = m.activeConnections[key]
	}

	// Update last used time
	conn.LastUsed = time.Now()
	controlPath := conn.ControlPath
	m.mutex.Unlock()

	// Execute command using the control socket
	cmd := exec.Command("ssh",
		"-o ConnectTimeout=5",
		"-S", controlPath,
		"-o", "StrictHostKeyChecking=no",
		fmt.Sprintf("%s@%s", username, hostname),
		command,
	)

	// Run the command and return output
	return cmd.CombinedOutput()
}

// Check if connection is active
func (m *SSHTunnelManager) IsConnectionActive(username, hostname string) bool {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	key := connectionKey(username, hostname)
	conn, exists := m.activeConnections[key]
	if !exists || !conn.Active {
		return false
	}

	// Test connection by running a simple command
	testCmd := exec.Command("ssh",
		"-o ConnectTimeout=5",
		"-S", conn.ControlPath,
		"-o", "StrictHostKeyChecking=no",
		fmt.Sprintf("%s@%s", username, hostname),
		"echo 'Connection test'",
	)

	if err := testCmd.Run(); err != nil {
		logger.Warnf("SSH connection for %s appears to be broken: %v", key, err)
		conn.Active = false
		return false
	}

	return true
}

// Get a list of all active connections
func (m *SSHTunnelManager) GetActiveConnections() []string {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	var connections []string
	for key, conn := range m.activeConnections {
		if conn.Active {
			connections = append(connections, key)
		}
	}
	return connections
}

// Clean up old, unused connections
func (m *SSHTunnelManager) CleanupIdleConnections(idleTimeout time.Duration) {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	now := time.Now()
	for key, conn := range m.activeConnections {
		if conn.Active && now.Sub(conn.LastUsed) > idleTimeout {
			logger.Infof("Closing idle SSH connection for %s (idle for %v)", key, now.Sub(conn.LastUsed))

			// Close the connection using control socket
			closeCmd := exec.Command("ssh",
				"-o ConnectTimeout=5",
				"-S", conn.ControlPath,
				"-O", "exit",
				fmt.Sprintf("%s@%s", conn.Username, conn.Hostname),
			)

			output, err := closeCmd.CombinedOutput()
			if err != nil {
				logger.Warnf("Error closing idle SSH connection: %v, output: %s", err, string(output))
				// Try to kill the process directly
				if conn.Cmd != nil && conn.Cmd.Process != nil {
					conn.Cmd.Process.Kill()
				}
			}

			// Clean up control socket
			if _, err := os.Stat(conn.ControlPath); err == nil {
				os.Remove(conn.ControlPath)
			}

			// Mark as inactive and remove from map
			conn.Active = false
			delete(m.activeConnections, key)
		}
	}
}

// Start the background cleanup routine
func (m *SSHTunnelManager) StartCleanupRoutine(checkInterval time.Duration, idleTimeout time.Duration) {
	go func() {
		ticker := time.NewTicker(checkInterval)
		defer ticker.Stop()

		for range ticker.C {
			m.CleanupIdleConnections(idleTimeout)
		}
	}()
}

// /////////////////////////////// SSH TunnelAPI Endpoints //////////////////////////////////////
// Request to open/close a tunnel
type TunnelRequest struct {
	Hostname string `json:"hostname"`
	Username string `json:"username"`
}

// Open an SSH tunnel
func openTunnel(ctx echo.Context) error {
	var req TunnelRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Open SSH tunnel
	if err := tunnelManager.OpenConnection(req.Username, req.Hostname); err != nil {
		logger.Errorf("Failed to open SSH tunnel: %v", err)
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("Failed to open SSH tunnel: %v", err),
		})
	}

	return ctx.JSON(http.StatusOK, map[string]string{
		"success": "true",
		"message": fmt.Sprintf("SSH tunnel opened for %s@%s", req.Username, req.Hostname),
	})
}

// Close an SSH tunnel
func closeTunnel(ctx echo.Context) error {
	var req TunnelRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Close SSH tunnel
	if err := tunnelManager.CloseConnection(req.Username, req.Hostname); err != nil {
		logger.Errorf("Failed to close SSH tunnel: %v", err)
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("Failed to close SSH tunnel: %v", err),
		})
	}

	return ctx.JSON(http.StatusOK, map[string]string{
		"success": "true",
		"message": fmt.Sprintf("SSH tunnel closed for %s@%s", req.Username, req.Hostname),
	})
}

// Get tunnel status
func getTunnelStatus(ctx echo.Context) error {
	username := ctx.QueryParam("username")
	hostname := ctx.QueryParam("hostname")

	if username == "" || hostname == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing username or hostname"})
	}

	isActive := tunnelManager.IsConnectionActive(username, hostname)

	return ctx.JSON(http.StatusOK, map[string]interface{}{
		"active":     isActive,
		"connection": fmt.Sprintf("%s@%s", username, hostname),
	})
}

// List all active tunnels
func listTunnels(ctx echo.Context) error {
	activeConnections := tunnelManager.GetActiveConnections()

	return ctx.JSON(http.StatusOK, map[string]interface{}{
		"active_tunnels": activeConnections,
	})
}

////////////////////////////////////

// Request for volume operations
type VolumeRequest struct {
	Hostname   string `json:"hostname"`
	Username   string `json:"username"`
	VolumeName string `json:"volumeName"`
}

// Request for network operations
type NetworkRequest struct {
	Hostname  string `json:"hostname"`
	Username  string `json:"username"`
	NetworkId string `json:"networkId"`
}

// List volumes
func listVolumes(ctx echo.Context) error {
	var req struct {
		Hostname string `json:"hostname"`
		Username string `json:"username"`
	}
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// First, get volume names and driver info
	dockerCommand := "docker volume ls --format '{{.Name}}|{{.Driver}}'"

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCommand)
	if err != nil {
		logger.Errorf("Error listing volumes: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to list volumes: %v", err),
			"output": string(output),
		})
	}

	// Parse the output into volume objects
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	volumes := make([]map[string]interface{}, 0, len(lines))

	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) != 2 {
			logger.Errorf("Invalid format for volume info: %s", line)
			continue
		}

		volumeName := parts[0]
		driver := parts[1]

		// Get detailed info about this volume
		inspectCommand := fmt.Sprintf("docker volume inspect %s", volumeName)
		inspectOutput, inspectErr := tunnelManager.ExecuteCommand(req.Username, req.Hostname, inspectCommand)

		mountpoint := "N/A"
		created := "N/A"
		labels := []string{}

		// If we can get inspect data, extract more info
		if inspectErr == nil && len(inspectOutput) > 0 {
			// Simple parsing approach - in production you'd want to properly parse JSON
			inspectStr := string(inspectOutput)

			// Extract mountpoint
			if mountStart := strings.Index(inspectStr, "\"Mountpoint\": \""); mountStart > 0 {
				mountStart += 15 // Length of "Mountpoint": "
				if mountEnd := strings.Index(inspectStr[mountStart:], "\""); mountEnd > 0 {
					mountpoint = inspectStr[mountStart : mountStart+mountEnd]
				}
			}

			// Extract creation time if available
			if createdStart := strings.Index(inspectStr, "\"CreatedAt\": \""); createdStart > 0 {
				createdStart += 14 // Length of "CreatedAt": "
				if createdEnd := strings.Index(inspectStr[createdStart:], "\""); createdEnd > 0 {
					created = inspectStr[createdStart : createdStart+createdEnd]
				}
			}

			// Extract labels
			if labelsStart := strings.Index(inspectStr, "\"Labels\": {"); labelsStart > 0 {
				labelsStart += 11 // Length of "Labels": {
				if labelsEnd := strings.Index(inspectStr[labelsStart:], "}"); labelsEnd > 0 {
					labelsSection := inspectStr[labelsStart : labelsStart+labelsEnd]
					labelPairs := strings.Split(labelsSection, ",")
					for _, pair := range labelPairs {
						if pair = strings.TrimSpace(pair); pair != "" {
							labels = append(labels, pair)
						}
					}
				}
			}
		}

		volume := map[string]interface{}{
			"name":       volumeName,
			"driver":     driver,
			"mountpoint": mountpoint,
			"created":    created,
			"size":       "N/A", // Size would require more complex commands to determine
			"labels":     labels,
		}
		volumes = append(volumes, volume)
	}

	return ctx.JSON(http.StatusOK, volumes)
}

// Remove a volume
func removeVolume(ctx echo.Context) error {
	var req VolumeRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" || req.VolumeName == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	dockerCommand := fmt.Sprintf("docker volume rm %s", req.VolumeName)

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCommand)
	if err != nil {
		logger.Errorf("Error removing volume: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to remove volume: %v", err),
			"output": string(output),
		})
	}

	return ctx.JSON(http.StatusOK, map[string]string{
		"success": "true",
		"message": fmt.Sprintf("Volume %s removed", req.VolumeName),
	})
}

// List networks
func listNetworks(ctx echo.Context) error {
	var req struct {
		Hostname string `json:"hostname"`
		Username string `json:"username"`
	}
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Format: ID|Name|Driver|Scope
	dockerCommand := "docker network ls --format '{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}'"

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCommand)
	if err != nil {
		logger.Errorf("Error listing networks: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to list networks: %v", err),
			"output": string(output),
		})
	}

	// Parse the output into network objects
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	networks := make([]map[string]interface{}, 0, len(lines))

	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) != 4 {
			logger.Errorf("Invalid format for network info: %s", line)
			continue
		}

		networkId := parts[0]
		name := parts[1]
		driver := parts[2]
		scope := parts[3]

		// Now get detailed info about this network
		inspectCmd := fmt.Sprintf("docker network inspect %s", networkId)

		// Execute command using SSH tunnel
		inspectOutput, inspectErr := tunnelManager.ExecuteCommand(req.Username, req.Hostname, inspectCmd)

		subnet := ""
		gateway := ""
		ipamDriver := "default"
		internal := false

		// If we can get inspect data, extract more info
		if inspectErr == nil && len(inspectOutput) > 0 {
			// Simple parsing approach - in production you'd want to properly parse JSON
			inspectStr := string(inspectOutput)

			// Extract IPAM driver
			if driverStart := strings.Index(inspectStr, "\"Driver\": \""); driverStart > 0 {
				driverStart += 11 // Length of "Driver": "
				if driverEnd := strings.Index(inspectStr[driverStart:], "\""); driverEnd > 0 {
					ipamDriver = inspectStr[driverStart : driverStart+driverEnd]
				}
			}

			// Extract subnet
			if subnetStart := strings.Index(inspectStr, "\"Subnet\": \""); subnetStart > 0 {
				subnetStart += 11 // Length of "Subnet": "
				if subnetEnd := strings.Index(inspectStr[subnetStart:], "\""); subnetEnd > 0 {
					subnet = inspectStr[subnetStart : subnetStart+subnetEnd]
				}
			}

			// Extract gateway
			if gatewayStart := strings.Index(inspectStr, "\"Gateway\": \""); gatewayStart > 0 {
				gatewayStart += 12 // Length of "Gateway": "
				if gatewayEnd := strings.Index(inspectStr[gatewayStart:], "\""); gatewayEnd > 0 {
					gateway = inspectStr[gatewayStart : gatewayStart+gatewayEnd]
				}
			}

			// Check if internal
			internal = strings.Contains(inspectStr, "\"Internal\": true")
		}

		network := map[string]interface{}{
			"id":         networkId,
			"name":       name,
			"driver":     driver,
			"scope":      scope,
			"ipamDriver": ipamDriver,
			"subnet":     subnet,
			"gateway":    gateway,
			"internal":   internal,
		}
		networks = append(networks, network)
	}

	return ctx.JSON(http.StatusOK, networks)
}

// Remove a network
func removeNetwork(ctx echo.Context) error {
	var req NetworkRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" || req.NetworkId == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// SSH to remote host and remove network
	dockerCommand := fmt.Sprintf("docker network rm %s", req.NetworkId)

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCommand)
	if err != nil {
		logger.Errorf("Error removing network: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to remove network: %v", err),
			"output": string(output),
		})
	}

	return ctx.JSON(http.StatusOK, map[string]string{
		"success": "true",
		"message": fmt.Sprintf("Network %s removed", req.NetworkId),
	})
}

// Request for container operations
type ContainerRequest struct {
	Hostname    string `json:"hostname"`
	Username    string `json:"username"`
	ContainerId string `json:"containerId"`
}

// Start a container
func startContainer(ctx echo.Context) error {
	var req ContainerRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" || req.ContainerId == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Format the docker command
	dockerCommand := fmt.Sprintf("docker start %s", req.ContainerId)

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCommand)
	if err != nil {
		logger.Errorf("Error starting container: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to start container: %v", err),
			"output": string(output),
		})
	}

	return ctx.JSON(http.StatusOK, map[string]string{
		"success": "true",
		"message": fmt.Sprintf("Container %s started", req.ContainerId),
	})
}

// Stop a container
func stopContainer(ctx echo.Context) error {
	var req ContainerRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" || req.ContainerId == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Format the docker command
	dockerCommand := fmt.Sprintf("docker stop %s", req.ContainerId)

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCommand)
	if err != nil {
		logger.Errorf("Error stopping container: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to stop container: %v", err),
			"output": string(output),
		})
	}

	return ctx.JSON(http.StatusOK, map[string]string{
		"success": "true",
		"message": fmt.Sprintf("Container %s stopped", req.ContainerId),
	})
}

// List images
func listImages(ctx echo.Context) error {
	var req struct {
		Hostname string `json:"hostname"`
		Username string `json:"username"`
	}
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Format the docker command
	dockerCommand := "docker images --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.CreatedSince}}|{{.Size}}'"

	// Execute command using SSH tunnel
	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCommand)
	if err != nil {
		logger.Errorf("Error listing images: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to list images: %v", err),
			"output": string(output),
		})
	}

	// Parse the output into image objects
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	images := make([]map[string]string, 0, len(lines))

	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) != 5 {
			logger.Errorf("Invalid format for image info: %s", line)
			continue
		}

		image := map[string]string{
			"id":         parts[0],
			"repository": parts[1],
			"tag":        parts[2],
			"created":    parts[3],
			"size":       parts[4],
		}
		images = append(images, image)
	}

	return ctx.JSON(http.StatusOK, images)
}

// Get settings from file
func getSettings(ctx echo.Context) error {
	// Ensure directory exists
	os.MkdirAll(filepath.Dir(settingsFilePath), 0755)

	// Check if settings file exists
	if _, err := os.Stat(settingsFilePath); os.IsNotExist(err) {
		// Return default settings if no settings exist yet
		defaultSettings := map[string]interface{}{
			"environments": []interface{}{},
			"autoConnect":  false,
		}
		jsonData, _ := json.Marshal(defaultSettings)
		return ctx.String(http.StatusOK, string(jsonData))
	}

	// Read settings file
	data, err := ioutil.ReadFile(settingsFilePath)
	if err != nil {
		logger.Errorf("Error reading settings: %v", err)
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error": "Failed to read settings",
		})
	}

	// Return settings data
	return ctx.String(http.StatusOK, string(data))
}

// Save settings to file
func saveSettings(ctx echo.Context) error {
	// Read request body
	body, err := ioutil.ReadAll(ctx.Request().Body)
	if err != nil {
		logger.Errorf("Error reading request body: %v", err)
		return ctx.JSON(http.StatusBadRequest, map[string]string{
			"error": "Failed to read request body",
		})
	}

	// Validate JSON
	var jsonData interface{}
	if err := json.Unmarshal(body, &jsonData); err != nil {
		logger.Errorf("Invalid JSON: %v", err)
		return ctx.JSON(http.StatusBadRequest, map[string]string{
			"error": "Invalid JSON format",
		})
	}

	// Ensure directory exists
	os.MkdirAll(filepath.Dir(settingsFilePath), 0755)

	// Write settings to file
	if err := ioutil.WriteFile(settingsFilePath, body, 0644); err != nil {
		logger.Errorf("Error writing settings: %v", err)
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error": "Failed to save settings",
		})
	}

	return ctx.JSON(http.StatusOK, map[string]string{
		"success": "true",
	})
}

// connectToRemoteDocker: called from the frontend to list containers
func connectToRemoteDocker(ctx echo.Context) error {
	var req SSHConnectionRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	if req.Hostname == "" || req.Username == "" {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
	}

	// Include Labels in docker ps
	dockerCommand := `docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.Labels}}'`

	output, err := tunnelManager.ExecuteCommand(req.Username, req.Hostname, dockerCommand)
	if err != nil {
		logger.Errorf("Error executing SSH command: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to connect: %v", err),
			"output": string(output),
		})
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	groupsMap := make(map[string][]DockerContainer)
	ungrouped := []DockerContainer{}

	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		// ID, Name, Image, Status, Ports, Labels
		if len(parts) != 6 {
			logger.Warnf("Invalid container info: %s", line)
			continue
		}

		container := DockerContainer{
			ID:     parts[0],
			Name:   parts[1],
			Image:  parts[2],
			Status: parts[3],
			Ports:  parts[4],
			Labels: parts[5],
		}

		// Check for compose project
		projectName := parseComposeProjectLabel(container.Labels)
		container.ComposeProject = projectName

		if projectName != "" {
			groupsMap[projectName] = append(groupsMap[projectName], container)
		} else {
			ungrouped = append(ungrouped, container)
		}
	}

	// Build final slice of ComposeGroup
	var composeGroups []ComposeGroup
	for projectName, containers := range groupsMap {
		status := computeGroupStatus(containers)
		composeGroups = append(composeGroups, ComposeGroup{
			Name:       projectName,
			Status:     status,
			Containers: containers,
		})
	}

	// Sort by project name
	sort.Slice(composeGroups, func(i, j int) bool {
		return composeGroups[i].Name < composeGroups[j].Name
	})

	response := DockerContainerResponse{
		ComposeGroups: composeGroups,
		Ungrouped:     ungrouped,
	}
	return ctx.JSON(http.StatusOK, response)
}

func computeGroupStatus(containers []DockerContainer) string {
	if len(containers) == 0 {
		return "No containers"
	}

	total := len(containers)
	countUp := 0
	for _, c := range containers {
		if strings.Contains(strings.ToLower(c.Status), "up") {
			countUp++
		}
	}

	switch {
	case countUp == 0:
		// none up
		return fmt.Sprintf("Stopped(%d)", total)
	case countUp == total:
		// all up
		return fmt.Sprintf("Running(%d)", total)
	default:
		// partial
		return fmt.Sprintf("Partial(%d/%d)", countUp, total)
	}
}

// parseComposeProjectLabel checks if the label string contains "com.docker.compose.project=XYZ"
// and returns the project name if found, or empty string if not found.
func parseComposeProjectLabel(labels string) string {
	// Example labels string might look like:
	//   "com.docker.compose.project=helios,com.docker.compose.version=2.15.1"
	// or it might be empty or have other labels
	pairs := strings.Split(labels, ",")
	for _, pair := range pairs {
		pair = strings.TrimSpace(pair)
		if strings.HasPrefix(pair, "com.docker.compose.project=") {
			// Extract everything after =
			return strings.TrimPrefix(pair, "com.docker.compose.project=")
		}
	}
	return ""
}

func listen(path string) (net.Listener, error) {
	return net.Listen("unix", path)
}

func hello(ctx echo.Context) error {
	return ctx.JSON(http.StatusOK, HTTPMessageBody{Message: "hello"})
}

type HTTPMessageBody struct {
	Message string
}
