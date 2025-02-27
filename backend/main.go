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
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/sirupsen/logrus"
)

var logger = logrus.New()

type SSHConnectionRequest struct {
	Hostname string `json:"hostname"`
	Username string `json:"username"`
}

type DockerContainer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	Status string `json:"status"`
}

// Settings data file path
const settingsFilePath = "/root/docker-extension/settings.json"

func main() {
	var socketPath string
	flag.StringVar(&socketPath, "socket", "/run/guest-services/backend.sock", "Unix domain socket to listen on")
	flag.Parse()

	_ = os.RemoveAll(socketPath)

	logger.SetOutput(os.Stdout)

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

	logger.Fatal(router.Start(startURL))
}

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

	// SSH to remote host and list volumes
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	// First, we'll get volume names and driver info
	dockerCommand := "docker volume ls --format '{{.Name}}|{{.Driver}}'"

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)
	logger.Infof("Executing: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
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

		// Now get detailed info about this volume
		inspectCmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand,
			fmt.Sprintf("docker volume inspect %s", volumeName))

		inspectOutput, inspectErr := inspectCmd.CombinedOutput()

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

	// SSH to remote host and remove volume
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	dockerCommand := fmt.Sprintf("docker volume rm %s", req.VolumeName)

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)
	logger.Infof("Executing: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
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

	// SSH to remote host and list networks
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	// Format: ID|Name|Driver|Scope
	dockerCommand := "docker network ls --format '{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}'"

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)
	logger.Infof("Executing: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
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
		inspectCmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand,
			fmt.Sprintf("docker network inspect %s", networkId))

		inspectOutput, inspectErr := inspectCmd.CombinedOutput()

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
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	dockerCommand := fmt.Sprintf("docker network rm %s", req.NetworkId)

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)
	logger.Infof("Executing: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
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

	// SSH to remote host and start container
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	dockerCommand := fmt.Sprintf("docker start %s", req.ContainerId)

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)
	logger.Infof("Executing: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
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

	// SSH to remote host and stop container
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	dockerCommand := fmt.Sprintf("docker stop %s", req.ContainerId)

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)
	logger.Infof("Executing: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
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

	// SSH to remote host and list images
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	// Format: ID|Repository|Tag|Created|Size
	dockerCommand := "docker images --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.CreatedSince}}|{{.Size}}'"

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)
	logger.Infof("Executing: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
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

func connectToRemoteDocker(ctx echo.Context) error {
	var req SSHConnectionRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	// The key issue is here - we need to pass the docker command as a single quoted string to SSH
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	// Notice the single quotes around the docker command - this preserves the format string
	dockerCommand := "docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}'"

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)

	logger.Infof("Executing command: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
	if err != nil {
		logger.Errorf("Error executing SSH command: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to connect: %v", err),
			"output": string(output),
		})
	}

	// Parse the output into container objects
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	containers := make([]DockerContainer, 0, len(lines))

	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) != 4 {
			logger.Errorf("Invalid format for container info: %s", line)
			continue
		}

		container := DockerContainer{
			ID:     parts[0],
			Name:   parts[1],
			Image:  parts[2],
			Status: parts[3],
		}
		containers = append(containers, container)
	}

	return ctx.JSON(http.StatusOK, containers)
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
